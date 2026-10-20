import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const key = z.string().min(8).max(160).optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'Use a valid calendar date in YYYY-MM-DD format.');
const pagination = { limit: z.number().int().min(1).max(50).default(20), cursor: z.string().regex(/^\d{1,8}$/).optional() };
export const schemas = {
  list_create: z.object({ name: text(80), description: z.string().trim().max(400).default(''), idempotencyKey: key }),
  lists_get: z.object({ includeArchived: z.boolean().default(false) }),
  list_archive: z.object({ list: text(100), archived: z.boolean().default(true), idempotencyKey: key }),
  items_add: z.object({ list: text(100).default('TODO'), items: z.array(z.object({
    title: text(300), quantity: z.string().trim().max(80).optional(),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
    dueDate: date.optional(), notes: z.string().trim().max(1000).default(''),
  })).min(1).max(30), idempotencyKey: key }),
  items_get: z.object({ list: text(100).default('TODO'), status: z.enum(['open', 'done', 'all']).default('open'), ...pagination }),
  item_update: z.object({ itemId: text(100), title: text(300).optional(),
    status: z.enum(['open', 'done']).optional(), priority: z.enum(['low', 'normal', 'high']).optional(),
    dueDate: date.nullable().optional(), quantity: z.string().trim().max(80).nullable().optional(),
    notes: z.string().trim().max(1000).optional(), idempotencyKey: key,
  }).refine(value => ['title', 'status', 'priority', 'dueDate', 'quantity', 'notes'].some(k => k in value), 'Provide an update.'),
  note_capture: z.object({ title: text(160), body: text(8000), tags: z.array(text(40)).max(12).default([]), idempotencyKey: key }),
  notes_search: z.object({ query: z.string().trim().max(200).default(''), tag: text(40).optional(), ...pagination }),
  deck_create: z.object({ name: text(100), description: z.string().trim().max(400).default(''), idempotencyKey: key }),
  decks_get: z.object({}),
  cards_add: z.object({ deck: text(120), cards: z.array(z.object({ question: text(1000), answer: text(3000) })).min(1).max(30), idempotencyKey: key }),
  study_next: z.object({ deck: text(120) }),
  study_reveal: z.object({ reviewId: text(100) }),
  study_grade: z.object({ reviewId: text(100), rating: z.enum(['again', 'hard', 'good', 'easy']) }),
  ride_briefing: z.object({ date: date.optional(), maxItems: z.number().int().min(1).max(10).default(5) }),
};

type Input<K extends keyof typeof schemas> = z.input<(typeof schemas)[K]>;
export interface List { id: string; name: string; description: string; archived: boolean; builtIn: boolean; createdAt: string }
export interface Item { id: string; listId: string; title: string; status: 'open' | 'done'; priority: 'low' | 'normal' | 'high'; dueDate?: string | null; quantity?: string | null; notes: string; createdAt: string; updatedAt: string; completedAt?: string }
interface Note { id: string; title: string; body: string; tags: string[]; createdAt: string }
interface Deck { id: string; name: string; description: string; createdAt: string }
interface Card { id: string; deckId: string; question: string; answer: string; dueAt: string; intervalDays: number; reviews: number }
interface Review { id: string; cardId: string; createdAt: string; revealed: boolean }
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
function page<T>(values: T[], limit: number, cursor?: string) {
  const offset = Number(cursor || 0);
  return { total: values.length, items: values.slice(offset, offset + limit), nextCursor: offset + limit < values.length ? String(offset + limit) : null };
}

export class Domain {
  constructor(readonly store: Store, private now = () => new Date(), readonly timeZone = 'UTC') {
    for (const [listId, name] of [['todo', 'TODO'], ['shopping', 'Shopping']] as const) {
      if (!store.get('lists', listId)) store.put('lists', listId, {
        id: listId, name, description: '', archived: false, builtIn: true, createdAt: this.now().toISOString(),
      } satisfies List);
    }
  }
  private list(reference: string): List {
    const list = this.store.get<List>('lists', reference)
      ?? this.store.all<List>('lists').find(value => normalize(value.name) === normalize(reference));
    if (!list) throw new Error('List not found. Use lists_get to find its name or ID.');
    return list;
  }
  createList(input: Input<'list_create'>) {
    const value = schemas.list_create.parse(input);
    return this.store.write('list_create', value.idempotencyKey, value, () => {
      if (this.store.all<List>('lists').some(list => normalize(list.name) === normalize(value.name))) throw new Error('A list with that name already exists.');
      const list: List = { id: id('list'), name: value.name, description: value.description, archived: false, builtIn: false, createdAt: this.now().toISOString() };
      this.store.put('lists', list.id, list);
      return list;
    });
  }
  getLists(input: Input<'lists_get'> = {}) {
    const { includeArchived } = schemas.lists_get.parse(input);
    const items = this.store.all<Item>('items');
    return this.store.all<List>('lists').filter(list => includeArchived || !list.archived)
      .map(list => ({ ...list, openItems: items.filter(item => item.listId === list.id && item.status === 'open').length }));
  }
  archiveList(input: Input<'list_archive'>) {
    const value = schemas.list_archive.parse(input);
    return this.store.write('list_archive', value.idempotencyKey, value, () => {
      const list = this.list(value.list);
      if (list.builtIn && value.archived) throw new Error('The TODO and Shopping lists are always available.');
      list.archived = value.archived;
      this.store.put('lists', list.id, list);
      return list;
    });
  }
  addItems(input: Input<'items_add'>) {
    const value = schemas.items_add.parse(input);
    return this.store.write('items_add', value.idempotencyKey, value, () => {
      const list = this.list(value.list);
      if (list.archived) throw new Error('Restore the list before adding items.');
      return value.items.map(entry => {
        const now = this.now().toISOString();
        const item: Item = { ...entry, id: id('item'), listId: list.id, status: 'open', createdAt: now, updatedAt: now };
        this.store.put('items', item.id, item);
        return item;
      });
    });
  }
  getItems(input: Input<'items_get'> = {}) {
    const value = schemas.items_get.parse(input);
    const list = this.list(value.list);
    const priority = { high: 0, normal: 1, low: 2 };
    const items = this.store.all<Item>('items').filter(item => item.listId === list.id && (value.status === 'all' || item.status === value.status))
      .sort((a, b) => priority[a.priority] - priority[b.priority] || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { list, ...page(items, value.limit, value.cursor) };
  }
  updateItem(input: Input<'item_update'>) {
    const value = schemas.item_update.parse(input);
    return this.store.write('item_update', value.idempotencyKey, value, () => {
      const item = this.store.get<Item>('items', value.itemId);
      if (!item) throw new Error('Item not found. Read the list first to get the exact item ID.');
      const { itemId: _id, idempotencyKey: _key, ...updates } = value;
      Object.assign(item, updates, { updatedAt: this.now().toISOString() });
      if (value.status === 'done') item.completedAt ??= this.now().toISOString();
      if (value.status === 'open') delete item.completedAt;
      this.store.put('items', item.id, item);
      return item;
    });
  }
  captureNote(input: Input<'note_capture'>) {
    const value = schemas.note_capture.parse(input);
    return this.store.write('note_capture', value.idempotencyKey, value, () => {
      const note: Note = { id: id('note'), title: value.title, body: value.body, tags: [...new Set(value.tags.map(normalize))], createdAt: this.now().toISOString() };
      this.store.put('notes', note.id, note);
      return note;
    });
  }
  searchNotes(input: Input<'notes_search'> = {}) {
    const value = schemas.notes_search.parse(input);
    const terms = normalize(value.query).split(' ').filter(Boolean);
    const notes = this.store.all<Note>('notes').filter(note => {
      const haystack = normalize(`${note.title} ${note.body} ${note.tags.join(' ')}`);
      return terms.every(term => haystack.includes(term)) && (!value.tag || note.tags.includes(normalize(value.tag)));
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return page(notes, value.limit, value.cursor);
  }
  private deck(reference: string): Deck {
    const deck = this.store.get<Deck>('decks', reference) ?? this.store.all<Deck>('decks').find(d => normalize(d.name) === normalize(reference));
    if (!deck) throw new Error('Deck not found. Use decks_get first.');
    return deck;
  }
  createDeck(input: Input<'deck_create'>) {
    const value = schemas.deck_create.parse(input);
    return this.store.write('deck_create', value.idempotencyKey, value, () => {
      if (this.store.all<Deck>('decks').some(deck => normalize(deck.name) === normalize(value.name))) throw new Error('A deck with that name already exists.');
      const deck: Deck = { id: id('deck'), name: value.name, description: value.description, createdAt: this.now().toISOString() };
      this.store.put('decks', deck.id, deck);
      return deck;
    });
  }
  getDecks() {
    const cards = this.store.all<Card>('cards');
    return this.store.all<Deck>('decks').map(deck => ({ ...deck,
      cards: cards.filter(card => card.deckId === deck.id).length,
      due: cards.filter(card => card.deckId === deck.id && card.dueAt <= this.now().toISOString()).length,
    }));
  }
  addCards(input: Input<'cards_add'>) {
    const value = schemas.cards_add.parse(input);
    return this.store.write('cards_add', value.idempotencyKey, value, () => {
      const deck = this.deck(value.deck);
      const cards = value.cards.map(entry => {
        const card: Card = { ...entry, id: id('card'), deckId: deck.id, dueAt: this.now().toISOString(), intervalDays: 0, reviews: 0 };
        this.store.put('cards', card.id, card);
        return { id: card.id, question: card.question };
      });
      return { deckId: deck.id, added: cards.length, cards };
    });
  }
  nextCard(input: Input<'study_next'>) {
    const value = schemas.study_next.parse(input);
    return this.store.transaction(() => {
      const deck = this.deck(value.deck);
      const cards = this.store.all<Card>('cards').filter(card => card.deckId === deck.id).sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
      const pending = this.store.all<Review>('reviews').find(review => cards.some(card => card.id === review.cardId));
      const card = pending ? cards.find(card => card.id === pending.cardId) : cards.find(card => card.dueAt <= this.now().toISOString());
      if (!card) return { done: true as const, due: 0, nextDueAt: cards[0]?.dueAt ?? null };
      const review: Review = pending ?? { id: id('review'), cardId: card.id, createdAt: this.now().toISOString(), revealed: false };
      this.store.put('reviews', review.id, review);
      return { done: false as const, reviewId: review.id, cardId: card.id, question: card.question,
        due: cards.filter(card => card.dueAt <= this.now().toISOString()).length };
    });
  }
  revealCard(input: Input<'study_reveal'>) {
    const { reviewId } = schemas.study_reveal.parse(input);
    const review = this.store.get<Review>('reviews', reviewId);
    if (!review) throw new Error('Review not found or already graded. Call study_next.');
    const card = this.store.get<Card>('cards', review.cardId)!;
    review.revealed = true;
    this.store.put('reviews', review.id, review);
    return { reviewId, question: card.question, answer: card.answer };
  }
  gradeCard(input: Input<'study_grade'>) {
    const value = schemas.study_grade.parse(input);
    return this.store.write('study_grade', value.reviewId, value, () => {
      const review = this.store.get<Review>('reviews', value.reviewId);
      if (!review) throw new Error('Review not found. Call study_next.');
      if (!review.revealed) throw new Error('Reveal the answer before grading this review.');
      const card = this.store.get<Card>('cards', review.cardId)!;
      const previous = card.intervalDays;
      card.intervalDays = value.rating === 'again' ? 0 : value.rating === 'hard' ? Math.max(1, Math.ceil(previous * 1.2))
        : value.rating === 'easy' ? Math.max(4, Math.ceil(previous * 3)) : Math.max(1, Math.ceil(previous * 2.5));
      card.intervalDays = Math.min(365, card.intervalDays);
      card.dueAt = new Date(this.now().valueOf() + (value.rating === 'again' ? 600_000 : card.intervalDays * 86_400_000)).toISOString();
      card.reviews++;
      this.store.put('cards', card.id, card);
      this.store.delete('reviews', review.id);
      return { cardId: card.id, rating: value.rating, nextDueAt: card.dueAt, intervalDays: card.intervalDays };
    });
  }
  briefing(input: Input<'ride_briefing'> = {}) {
    const value = schemas.ride_briefing.parse(input);
    const today = value.date ?? new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone }).format(this.now());
    const active = new Set(this.getLists().filter(list => list.id !== 'shopping').map(list => list.id));
    const tasks = this.store.all<Item>('items').filter(item => active.has(item.listId) && item.status === 'open');
    const attention = tasks.filter(task => task.priority === 'high' || (task.dueDate && task.dueDate <= today))
      .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.createdAt.localeCompare(b.createdAt));
    return { asOf: this.now().toISOString(), date: today, timeZone: this.timeZone,
      openTasks: tasks.length, overdue: tasks.filter(task => task.dueDate && task.dueDate < today).length,
      attention: attention.slice(0, value.maxItems),
      shopping: { openItems: this.getItems({ list: 'shopping' }).total },
      study: this.getDecks().filter(deck => deck.due > 0),
      recentCaptures: this.searchNotes({ limit: 3 }).items.map(({ id, title, createdAt }) => ({ id, title, createdAt })),
      delivery: 'Pull-based snapshot. Ask again for updates; this server does not send notifications.',
    };
  }
}
