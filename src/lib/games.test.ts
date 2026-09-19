import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../../db/test-helpers';
import { categories, publishers, games } from '../../db/schema';
import type { Database } from './db';
import {
    getAllGames,
    getAllGameIds,
    getAllCategories,
    getAllPublishers,
    getFilteredGames,
    getGameById,
} from './games';

async function seedGames(db: Database, count: number): Promise<void> {
    const [category] = await db
        .insert(categories)
        .values({ name: 'Strategy', description: 'cat' })
        .returning({ id: categories.id });
    const [publisher] = await db
        .insert(publishers)
        .values({ name: 'Pub One', description: 'pub' })
        .returning({ id: publishers.id });

    // Insert titles in reverse-alphabetical order to prove ordering is applied.
    for (let i = count; i >= 1; i--) {
        await db.insert(games).values({
            title: `Game ${String(i).padStart(2, '0')}`,
            description: `Description ${i}`,
            starRating: 4.2,
            categoryId: category.id,
            publisherId: publisher.id,
        });
    }
}

describe('games data-access helpers', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns all games ordered by title', async () => {
        await seedGames(db, 3);
        const all = await getAllGames(db);
        expect(all.map((g) => g.title)).toEqual(['Game 01', 'Game 02', 'Game 03']);
        expect(all[0].category).toEqual({ id: expect.any(Number), name: 'Strategy' });
        expect(all[0].publisher).toEqual({ id: expect.any(Number), name: 'Pub One' });
    });

    it('returns all game ids ordered by title', async () => {
        await seedGames(db, 3);
        const ids = await getAllGameIds(db);
        const all = await getAllGames(db);
        expect(ids).toEqual(all.map((g) => g.id));
    });

    it('fetches a single game by id', async () => {
        await seedGames(db, 2);
        const ids = await getAllGameIds(db);
        const game = await getGameById(db, ids[0]);
        expect(game?.title).toBe('Game 01');
    });

    it('returns null for a non-existent game', async () => {
        await seedGames(db, 2);
        expect(await getGameById(db, 99999)).toBeNull();
    });

    it('filters games by one or more categories and publisher', async () => {
        const [strategy] = await db
            .insert(categories)
            .values([
                { name: 'Strategy', description: 'strategy' },
                { name: 'Puzzle', description: 'puzzle' },
            ])
            .returning({ id: categories.id, name: categories.name });
        const [firstPublisher] = await db
            .insert(publishers)
            .values([
                { name: 'Pub One', description: 'one' },
                { name: 'Pub Two', description: 'two' },
            ])
            .returning({ id: publishers.id, name: publishers.name });
        const [secondCategory] = await db
            .select({ id: categories.id })
            .from(categories)
            .where(eq(categories.name, 'Puzzle'));
        const [secondPublisher] = await db
            .select({ id: publishers.id })
            .from(publishers)
            .where(eq(publishers.name, 'Pub Two'));

        await db.insert(games).values([
            {
                title: 'Strategy One',
                description: 'one',
                starRating: 4,
                categoryId: strategy.id,
                publisherId: firstPublisher.id,
            },
            {
                title: 'Puzzle One',
                description: 'two',
                starRating: 4,
                categoryId: secondCategory.id,
                publisherId: firstPublisher.id,
            },
            {
                title: 'Puzzle Two',
                description: 'three',
                starRating: 4,
                categoryId: secondCategory.id,
                publisherId: secondPublisher.id,
            },
        ]);

        expect(
            (await getFilteredGames(db, { categoryIds: [strategy.id, secondCategory.id] }))
                .map((game) => game.title),
        ).toEqual(['Puzzle One', 'Puzzle Two', 'Strategy One']);
        expect(
            (await getFilteredGames(db, { publisherId: firstPublisher.id })).map(
                (game) => game.title,
            ),
        ).toEqual(['Puzzle One', 'Strategy One']);
        expect(
            (
                await getFilteredGames(db, {
                    categoryIds: [secondCategory.id],
                    publisherId: secondPublisher.id,
                })
            ).map((game) => game.title),
        ).toEqual(['Puzzle Two']);
        expect(
            await getFilteredGames(db, {
                categoryIds: [strategy.id],
                publisherId: secondPublisher.id,
            }),
        ).toEqual([]);
    });

    it('returns categories and publishers in alphabetical order', async () => {
        await db.insert(categories).values([
            { name: 'Strategy', description: 'strategy' },
            { name: 'Puzzle', description: 'puzzle' },
        ]);
        await db.insert(publishers).values([
            { name: 'Pub Two', description: 'two' },
            { name: 'Pub One', description: 'one' },
        ]);

        expect((await getAllCategories(db)).map((item) => item.name)).toEqual([
            'Puzzle',
            'Strategy',
        ]);
        expect((await getAllPublishers(db)).map((item) => item.name)).toEqual([
            'Pub One',
            'Pub Two',
        ]);
    });
});
