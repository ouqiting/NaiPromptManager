
import { LocalGenItem, NAIParams } from '../types';

const DB_NAME = 'NAI_History_DB';
const STORE_NAME = 'generations';
const DB_VERSION = 1;

class LocalHistoryService {
    private db: IDBDatabase | null = null;

    private async open(): Promise<IDBDatabase> {
        if (this.db) return this.db;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
            };

            request.onsuccess = (event) => {
                this.db = (event.target as IDBOpenDBRequest).result;
                resolve(this.db);
            };

            request.onerror = (event) => {
                reject((event.target as IDBOpenDBRequest).error);
            };
        });
    }

    async add(imageUrl: string, prompt: string, negativePrompt: string, params: NAIParams): Promise<LocalGenItem> {
        const db = await this.open();
        const item: LocalGenItem = {
            id: crypto.randomUUID(),
            imageUrl,
            prompt,
            negativePrompt,
            params,
            createdAt: Date.now(),
            driveStatus: 'pending'
        };

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.add(item);

            request.onsuccess = () => resolve(item);
            request.onerror = () => reject(request.error);
        });
    }

    async upsert(item: LocalGenItem): Promise<void> {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(item);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getById(id: string): Promise<LocalGenItem | null> {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(id);

            request.onsuccess = () => resolve((request.result as LocalGenItem) || null);
            request.onerror = () => reject(request.error);
        });
    }

    async update(id: string, updater: (item: LocalGenItem) => LocalGenItem): Promise<LocalGenItem | null> {
        const existing = await this.getById(id);
        if (!existing) {
            return null;
        }

        const updated = updater(existing);
        await this.upsert(updated);
        return updated;
    }

    async getPendingSyncItems(folderId?: string): Promise<LocalGenItem[]> {
        const items = await this.getAll();
        return items.filter(item => {
            if (folderId && item.driveFolderId && item.driveFolderId !== folderId) {
                return true;
            }

            return item.driveStatus !== 'synced' || !item.driveImageFileId || !item.driveMetaFileId;
        });
    }

    async getAll(): Promise<LocalGenItem[]> {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('createdAt');
            // Get latest first
            const request = index.openCursor(null, 'prev'); 
            const results: LocalGenItem[] = [];

            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result;
                if (cursor) {
                    results.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async delete(id: string): Promise<void> {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
    
    async clear(): Promise<void> {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 分页查询历史记录
     * @param page 页码（从0开始）
     * @param pageSize 每页数量
     * @returns 当前页的记录数组
     */
    async getPage(page: number, pageSize: number): Promise<LocalGenItem[]> {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('createdAt');
            
            // 计算跳过的数量
            const skipCount = page * pageSize;
            const results: LocalGenItem[] = [];
            let skipped = 0;
            
            // 使用游标遍历，从最新记录开始
            const request = index.openCursor(null, 'prev');
            
            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result;
                if (cursor && results.length < pageSize) {
                    if (skipped < skipCount) {
                        skipped++;
                        cursor.continue();
                    } else {
                        results.push(cursor.value);
                        cursor.continue();
                    }
                } else {
                    resolve(results);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 获取历史记录总数
     * @returns 记录总数
     */
    async getCount(): Promise<number> {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.count();
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 删除指定天数之前的历史记录
     * @param days 天数
     * @returns 删除的记录数量
     */
    async deleteOlderThan(days: number): Promise<number> {
        const db = await this.open();
        const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('createdAt');
            let deletedCount = 0;
            
            // 使用范围查询 createdAt < cutoffTime 的记录
            const range = IDBKeyRange.upperBound(cutoffTime, true);
            const request = index.openCursor(range);
            
            // 事务完成处理
            transaction.oncomplete = () => {
                resolve(deletedCount);
            };
            
            transaction.onerror = () => {
                reject(transaction.error);
            };
            
            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result;
                if (cursor) {
                    cursor.delete();
                    deletedCount++;
                    cursor.continue();
                }
                // 注意：不在这里resolve，等待事务完成
            };
            
            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    /**
     * 只保留最近的 N 条记录，删除多余的
     * @param n 要保留的记录数量
     * @returns 删除的记录数量
     */
    async keepOnly(n: number): Promise<number> {
        const db = await this.open();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('createdAt');
            let deletedCount = 0;
            let index_count = 0;
            
            // 事务完成处理
            transaction.oncomplete = () => {
                resolve(deletedCount);
            };
            
            transaction.onerror = () => {
                reject(transaction.error);
            };
            
            // 从最新记录开始遍历
            const request = index.openCursor(null, 'prev');
            
            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result;
                if (cursor) {
                    index_count++;
                    if (index_count > n) {
                        cursor.delete();
                        deletedCount++;
                    }
                    cursor.continue();
                }
                // 注意：不在这里resolve，等待事务完成
            };
            
            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    /**
     * 统计指定天数之前的记录数量
     * @param days 天数
     * @returns 记录数量
     */
    async countOlderThan(days: number): Promise<number> {
        const db = await this.open();
        const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('createdAt');
            
            // 使用范围查询 createdAt < cutoffTime 的记录
            const range = IDBKeyRange.upperBound(cutoffTime, true);
            const request = index.count(range);
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
}

export const localHistory = new LocalHistoryService();
