/**
 * Tipster-AI Database Manager
 * 
 * Contains all logic for:
 * - LocalDB (IndexedDB management)
 * - Safe Firebase Uploads (Chunked batches > 500)
 * - Strategy Saving & Ranking History
 * - Match Data Persistence
 */

// ==================== INDEXED DB (Local Cache) ====================
// Used for "Local Mode" or caching large datasets without reducing Firestore quota
const LocalDB = {
    dbName: 'TipsterDB',
    storeName: 'matches',
    storeStrategies: 'strategies_history',
    storeLeagues: 'leagues_registry',
    storeCatalog: 'leagues_catalog', // NEW: Full API-Football catalog
    db: null,

    async init() {
        if (this.db) return;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 5); // Upgrade to v5 for leagues_catalog

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(this.storeStrategies)) {
                    db.createObjectStore(this.storeStrategies, { keyPath: 'date' });
                }
                if (!db.objectStoreNames.contains(this.storeLeagues)) {
                    db.createObjectStore(this.storeLeagues, { keyPath: 'name' });
                }
                if (!db.objectStoreNames.contains(this.storeCatalog)) {
                    const catalogStore = db.createObjectStore(this.storeCatalog, { keyPath: 'id' });
                    catalogStore.createIndex('country', 'country', { unique: false });
                    catalogStore.createIndex('name', 'name', { unique: false });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log("[LocalDB] Initialized");
                resolve(this.db);
            };

            request.onerror = (event) => {
                console.error("[LocalDB] Init Error", event);
                reject(event);
            };
        });
    },

    async saveMatches(matches) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);

            // Clear old data first (full replacement strategy)
            store.clear();

            matches.forEach(match => {
                store.put(match);
            });

            transaction.oncomplete = () => {
                console.log(`[LocalDB] Saved ${matches.length} matches`);
                resolve(true);
            };

            transaction.onerror = (event) => {
                console.error("[LocalDB] Save Error", event);
                reject(event);
            };
        });
    },

    async updateMatches(matches) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);

            // Access to fetch at 'https://v3.football.api-sports.io/odds?fixture=...' - Update only, NO CLEAR
            matches.forEach(match => {
                store.put(match);
            });

            transaction.oncomplete = () => {
                console.log(`[LocalDB] Updated ${matches.length} matches`);
                resolve(true);
            };

            transaction.onerror = (event) => {
                console.error("[LocalDB] Update Error", event);
                reject(event);
            };
        });
    },

    async loadMatches() {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readonly");
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();

            request.onsuccess = () => {
                console.log(`[LocalDB] Loaded ${request.result.length} matches`);
                resolve(request.result || []);
            };

            request.onerror = (event) => {
                reject(event);
            };
        });
    },

    async clear() {
        if (!this.db) await this.init();
        const transaction = this.db.transaction([this.storeName, this.storeStrategies, this.storeLeagues], "readwrite");
        transaction.objectStore(this.storeName).clear();
        transaction.objectStore(this.storeStrategies).clear();
        transaction.objectStore(this.storeLeagues).clear();
        console.log("[LocalDB] Cleared all stores");
    },

    // ==================== STRATEGIES HISTORY (DATABASE ORO) ====================

    async saveStrategyHistory(date, strategiesMap) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeStrategies], "readwrite");
            const store = transaction.objectStore(this.storeStrategies);

            const record = {
                date: date,
                lastUpdated: Date.now(),
                strategies: strategiesMap // Full clone of strategies
            };

            const request = store.put(record);

            request.onsuccess = () => {
                console.log(`[LocalDB-Oro] Saved history for ${date}`);
                resolve(true);
            };

            request.onerror = (event) => {
                console.error("[LocalDB-Oro] Save Error", event);
                reject(event);
            };
        });
    },

    async getAllStrategies() {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeStrategies], "readonly");
            const store = transaction.objectStore(this.storeStrategies);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => reject(event);
        });
    },

    async loadStrategyHistory(date) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeStrategies], "readonly");
            const store = transaction.objectStore(this.storeStrategies);
            const request = store.get(date);

            request.onsuccess = () => {
                resolve(request.result ? request.result.strategies : null);
            };

            request.onerror = (event) => {
                reject(event);
            };
        });
    },

    // ==================== LEAGUES REGISTRY (Dizionario Dinamico) ====================

    async saveLeagueMapping(name, id, meta = {}) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeLeagues], "readwrite");
            const store = transaction.objectStore(this.storeLeagues);

            const record = {
                name: name.toLowerCase().trim(),
                leagueId: id,
                updatedAt: Date.now(),
                ...meta
            };

            const request = store.put(record);
            request.onsuccess = () => resolve(true);
            request.onerror = (event) => reject(event);
        });
    },

    async getLeagueMapping(name) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeLeagues], "readonly");
            const store = transaction.objectStore(this.storeLeagues);
            const request = store.get(name.toLowerCase().trim());
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event) => reject(event);
        });
    },

    async getAllLeagues() {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeLeagues], "readonly");
            const store = transaction.objectStore(this.storeLeagues);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => reject(event);
        });
    },

    async saveLeagueMappingsBulk(mappings) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeLeagues], "readwrite");
            const store = transaction.objectStore(this.storeLeagues);

            mappings.forEach(m => {
                const record = {
                    name: m.label.toLowerCase().trim(),
                    leagueId: parseInt(m.id),
                    updatedAt: Date.now(),
                    ...m.meta
                };
                store.put(record);
            });

            transaction.oncomplete = () => {
                console.log(`[LocalDB] Bulk saved ${mappings.length} leagues`);
                resolve(true);
            };
            transaction.onerror = (event) => {
                console.error("[LocalDB] Bulk Save Error", event);
                reject(event);
            };
        });
    },

    // Alias for getAllLeagues (used in admin.html)
    async getAllLeagueMappings() {
        return this.getAllLeagues();
    },

    // Alias for loadMatches (used in admin.html)
    async getAllMatches() {
        return this.loadMatches();
    },

    // ==================== LEAGUES CATALOG (API-Football Full Catalog) ====================

    async saveCatalog(leagues) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeCatalog], "readwrite");
            const store = transaction.objectStore(this.storeCatalog);

            // Clear and replace
            store.clear();

            leagues.forEach(league => {
                store.put(league);
            });

            transaction.oncomplete = () => {
                console.log(`[LocalDB] Saved ${leagues.length} leagues to catalog`);
                resolve(true);
            };
            transaction.onerror = (event) => reject(event);
        });
    },

    async getCatalog() {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeCatalog], "readonly");
            const store = transaction.objectStore(this.storeCatalog);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => reject(event);
        });
    },

    async searchCatalog(name, country = null) {
        if (!this.db) await this.init();
        const catalog = await this.getCatalog();

        const cleanName = name.toLowerCase().trim();
        const cleanCountry = country ? country.toLowerCase().trim() : null;

        return catalog.filter(l => {
            const nameMatch = l.name.toLowerCase().includes(cleanName) ||
                cleanName.includes(l.name.toLowerCase());
            const countryMatch = cleanCountry ?
                l.country.toLowerCase() === cleanCountry : true;
            return nameMatch && countryMatch;
        });
    },

    async getCatalogByCountry(country) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeCatalog], "readonly");
            const store = transaction.objectStore(this.storeCatalog);
            const index = store.index('country');
            const request = index.getAll(country);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => reject(event);
        });
    },


    async importStrategiesHistory(backupData) {
        if (!this.db) await this.init();

        // Handle both formats: old array or new backup object
        const historyArray = Array.isArray(backupData) ? backupData : backupData.history;
        const leaguesArray = backupData.leagues || [];

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeStrategies, this.storeLeagues], "readwrite");
            const strategyStore = transaction.objectStore(this.storeStrategies);
            const leagueStore = transaction.objectStore(this.storeLeagues);

            let strategyCount = 0;
            if (Array.isArray(historyArray)) {
                historyArray.forEach(item => {
                    if (item.date && item.strategies) {
                        strategyStore.put(item);
                        strategyCount++;
                    }
                });
            }

            let leagueCount = 0;
            leaguesArray.forEach(league => {
                if (league.name && league.leagueId) {
                    leagueStore.put(league);
                    leagueCount++;
                }
            });

            transaction.oncomplete = () => {
                console.log(`[LocalDB] Imported ${strategyCount} days and ${leagueCount} leagues`);
                resolve(strategyCount);
            };

            transaction.onerror = (event) => {
                console.error("[LocalDB] Import Error", event);
                reject(event);
            };
        });
    },

    /**
     * Export Strategies History (ML Ready)
     */
    async exportStrategiesHistory() {
        if (!this.db) await this.init();
        const exportData = {
            type: 'strategies_backup',
            version: '1.2',
            exportedAt: new Date().toISOString(),
            history: [],
            leagues: []
        };

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeStrategies, this.storeLeagues], "readonly");
            const strategyStore = transaction.objectStore(this.storeStrategies);
            const leagueStore = transaction.objectStore(this.storeLeagues);

            const strategyRequest = strategyStore.getAll();
            const leagueRequest = leagueStore.getAll();

            let completed = 0;
            const checkDone = () => {
                completed++;
                if (completed === 2) resolve(exportData);
            };

            strategyRequest.onsuccess = () => {
                exportData.history = strategyRequest.result || [];
                checkDone();
            };

            leagueRequest.onsuccess = () => {
                exportData.leagues = leagueRequest.result || [];
                checkDone();
            };

            transaction.onerror = (event) => reject(event);
        });
    }
};


// ==================== FIREBASE BATCH MANAGER ====================
// Solves the 500 operations/batch limit by chunking requests

/**
 * Commits a large number of operations to Firestore by splitting them into batches of 450.
 * @param {object} db - Firestore database instance
 * @param {Array} operations - Array of objects { type: 'set'|'update'|'delete', ref: docRef, data: object }
 * @param {Function} onProgress - Callback (processedCount, total) => void
 */
async function safeBatchCommit(db, operations, onProgress = null) {
    // Import needed functions if not available in scope, 
    // BUT we assume writeBatch is passed or available globally in this context.
    // In strict modules we would import { writeBatch } from firebase.
    // For this refactoring, we rely on the main app module passing 'db' 
    // and correctly executing `writeBatch(db)`.

    const BATCH_SIZE = 450; // Safety margin below 500
    const total = operations.length;
    let processed = 0;

    // chunk operations
    for (let i = 0; i < total; i += BATCH_SIZE) {
        const chunk = operations.slice(i, i + BATCH_SIZE);
        const batch = window.writeBatch(db); // Use window.writeBatch from main module

        chunk.forEach(op => {
            if (op.type === 'set') {
                batch.set(op.ref, op.data, op.options);
            } else if (op.type === 'update') {
                batch.update(op.ref, op.data);
            } else if (op.type === 'delete') {
                batch.delete(op.ref);
            }
        });

        await batch.commit();
        processed += chunk.length;
        console.log(`[SafeBatch] Committed ${processed}/${total} operations`);

        if (onProgress) {
            onProgress(processed, total);
        }
    }
    return processed;
}

/**
 * Handle massive upload of matches (Tips or Results)
 * Replaces the monolithic handleUploadConfirmed in admin.html
 */
async function uploadMatchesToFirebase(type, dataToUpload, existingMatches = [], db) {
    if (!dataToUpload || dataToUpload.length === 0) return 0;

    const matchesCollection = window.collection(db, "matches");
    let operations = [];

    // Pre-process items to determine if update or new create
    // We use a Map for existing matches for O(1) lookup
    const existingMap = new Map();
    existingMatches.forEach(m => {
        // Create unique key: date_teams (approx)
        if (m.data && m.partita) existingMap.set(`${m.data}_${m.partita}`, m.id);
    });

    for (const match of dataToUpload) {
        // Try to find existing ID
        let existingId = match.id;
        if (!existingId) {
            const key = `${match.data}_${match.partita}`;
            if (existingMap.has(key)) {
                existingId = existingMap.get(key);
            }
        }

        if (existingId) {
            // MERGE UPDATE
            const docRef = window.doc(matchesCollection, existingId);
            operations.push({
                type: 'set',
                ref: docRef,
                data: match,
                options: { merge: true }
            });
        } else {
            // NEW CREATE
            const docRef = window.doc(matchesCollection); // Auto-ID
            // Add ID to match object for consistency
            match.id = docRef.id;
            operations.push({
                type: 'set',
                ref: docRef,
                data: match
            });
        }
    }

    console.log(`[Upload] Prepared ${operations.length} operations. Starting safe commit...`);

    // Execute safe batch
    await safeBatchCommit(db, operations, (processed, total) => {
        // Provide UI feedback via DOM if element exists
        const btn = document.getElementById(`confirm-${type}-upload-btn`);
        if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Salvataggio ${processed}/${total}...`;
    });

    return operations.length;
}

/**
 * Save strategy calculations to daily_strategies collection history
 * 🔥 UPDATED: Uses subcollections to avoid 1MB document limit
 * Structure: daily_strategies/{date}/strategies/{strategyId}
 */
async function saveStrategyToHistory(db, targetDate, strategiesMap) {
    if (!strategiesMap || Object.keys(strategiesMap).length === 0) return;

    try {
        // 1. First, create/update the parent document with metadata only
        const parentDocRef = window.doc(db, "daily_strategies", targetDate);
        await window.setDoc(parentDocRef, {
            date: targetDate,
            lastUpdated: Date.now(),
            strategyCount: Object.keys(strategiesMap).length,
            strategyIds: Object.keys(strategiesMap)
        }, { merge: true });

        // 2. Save each strategy as a separate document in subcollection
        const strategiesCollectionRef = window.collection(parentDocRef, "strategies");

        for (const [stratId, stratData] of Object.entries(strategiesMap)) {
            const stratDocRef = window.doc(strategiesCollectionRef, stratId);

            // Prepare data - remove circular refs and limit size
            const cleanData = {
                id: stratId,
                name: stratData.name || stratId,
                type: stratData.type || 'standard',
                totalMatches: stratData.totalMatches || (stratData.matches?.length || 0),
                matches: (stratData.matches || []).map(m => {
                    // Build match object, only including defined values
                    const matchData = {};
                    if (m.id !== undefined) matchData.id = m.id;
                    if (m.partita !== undefined) matchData.partita = m.partita;
                    if (m.lega !== undefined) matchData.lega = m.lega;
                    if (m.data !== undefined) matchData.data = m.data;
                    if (m.tip !== undefined) matchData.tip = m.tip;
                    if (m.quota !== undefined) matchData.quota = m.quota;
                    if (m.score !== undefined) matchData.score = m.score;
                    if (m.risultato !== undefined) matchData.risultato = m.risultato;
                    if (m.esito !== undefined) matchData.esito = m.esito;
                    if (m.ora !== undefined) matchData.ora = m.ora;
                    if (m.fixtureId !== undefined) matchData.fixtureId = m.fixtureId;
                    if (m.originalDBTip !== undefined) matchData.originalDBTip = m.originalDBTip;
                    if (m.originalDBQuota !== undefined) matchData.originalDBQuota = m.originalDBQuota;
                    if (m.isReinforced !== undefined) matchData.isReinforced = m.isReinforced;
                    if (m.reasoning !== undefined) matchData.reasoning = m.reasoning;

                    // 🔥 Intelligence Fields (Standings & Motivation)
                    if (m.leagueId !== undefined) matchData.leagueId = m.leagueId;
                    if (m.motivationBadges !== undefined) matchData.motivationBadges = m.motivationBadges;
                    if (m.eloRatingH !== undefined) matchData.eloRatingH = m.eloRatingH;
                    if (m.eloRatingA !== undefined) matchData.eloRatingA = m.eloRatingA;
                    if (m.rankH !== undefined) matchData.rankH = m.rankH;
                    if (m.rankA !== undefined) matchData.rankA = m.rankA;
                    if (m.teamIdHome !== undefined) matchData.teamIdHome = m.teamIdHome;
                    if (m.teamIdAway !== undefined) matchData.teamIdAway = m.teamIdAway;
                    if (m.expertStats !== undefined) matchData.expertStats = m.expertStats;

                    // Compact magicStats (only if exists)
                    if (m.magicStats) {
                        matchData.magicStats = {};
                        if (m.magicStats.tipMagiaAI !== undefined) matchData.magicStats.tipMagiaAI = m.magicStats.tipMagiaAI;
                        if (m.magicStats.probMagiaAI !== undefined) matchData.magicStats.probMagiaAI = m.magicStats.probMagiaAI;
                        if (m.magicStats.oddMagiaAI !== undefined) matchData.magicStats.oddMagiaAI = m.magicStats.oddMagiaAI;
                        if (m.magicStats.smartScore !== undefined) matchData.magicStats.smartScore = m.magicStats.smartScore;
                        if (m.magicStats.top3Scores !== undefined) matchData.magicStats.top3Scores = m.magicStats.top3Scores;

                        // 🔥 Intelligence in magicStats too
                        if (m.magicStats.motivationBadges !== undefined) matchData.magicStats.motivationBadges = m.magicStats.motivationBadges;
                        if (m.magicStats.eloRatingH !== undefined) matchData.magicStats.eloRatingH = m.magicStats.eloRatingH;
                        if (m.magicStats.eloRatingA !== undefined) matchData.magicStats.eloRatingA = m.magicStats.eloRatingA;
                        if (m.magicStats.rankH !== undefined) matchData.magicStats.rankH = m.magicStats.rankH;
                        if (m.magicStats.rankA !== undefined) matchData.magicStats.rankA = m.magicStats.rankA;
                    }

                    return matchData;
                }),
                lastUpdated: Date.now()
            };

            await window.setDoc(stratDocRef, cleanData, { merge: true });
            console.log(`[History] Saved strategy: ${stratId} (${cleanData.totalMatches} matches)`);
        }

        console.log(`[History] Saved ${Object.keys(strategiesMap).length} strategies for ${targetDate} to Firebase`);

        // 🔥 ORO DATABASE: Save permanently to Local IndexedDB
        await window.LocalDB.saveStrategyHistory(targetDate, strategiesMap);
        console.log(`[History] Permanent Snapshot saved to Database Oro (Local)`);
    } catch (e) {
        console.error(`[History] Save Error:`, e);
        throw e;
    }
}

/**
 * Cleanup old strategies (> 7 days)
 */
async function cleanupOldStrategies(db) {
    try {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const cutoffDate = sevenDaysAgo.toISOString().split('T')[0];

        const strategiesCol = window.collection(db, "daily_strategies");
        // We can't query by ID inequality easily, so we fetch all keys or query by 'date' field
        const q = window.query(strategiesCol, window.where('date', '<', cutoffDate));

        const snapshot = await window.getDocs(q);
        if (snapshot.empty) return;

        const operations = [];
        snapshot.forEach(docSnap => {
            operations.push({
                type: 'delete',
                ref: docSnap.ref
            });
        });

        if (operations.length > 0) {
            console.log(`[Cleanup] Removing ${operations.length} old strategy docs`);
            await safeBatchCommit(db, operations);
        }
    } catch (e) {
        console.error("[Cleanup] Error:", e);
    }
}

// Export for global usage
window.LocalDB = LocalDB;
window.databaseManager = {
    safeBatchCommit,
    uploadMatchesToFirebase,
    saveStrategyToHistory,
    cleanupOldStrategies,
    cleanupOldFirebaseHistory: cleanupOldStrategies // Alias for clarity in plan
};
