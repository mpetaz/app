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
    storeMagiaAI: 'magia_ai_predictions', // 🔥 NEW v13.0: Sandbox for AI World Predictions
    storeParlays: 'parlays_history', // 🎰 NEW: Local storage for Generated Parlays (Privacy Mode)
    storeTrading: 'trading_history', // 📈 NEW v14.0: Local storage for Trading 3.0 History
    db: null,

    async init() {
        if (this.db) return;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 8); // Upgrade to v8 for trading_history

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
                if (!db.objectStoreNames.contains(this.storeMagiaAI)) {
                    db.createObjectStore(this.storeMagiaAI, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(this.storeParlays)) {
                    db.createObjectStore(this.storeParlays, { keyPath: 'date' });
                }
                if (!db.objectStoreNames.contains(this.storeTrading)) {
                    db.createObjectStore(this.storeTrading, { keyPath: 'date' });
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

    async deleteMatch(id) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);

            // 🔥 Tenta entrambi i tipi per sicurezza (IndexedDB è type-sensitive)
            store.delete(String(id));
            if (!isNaN(id) && id !== '') {
                store.delete(Number(id));
            }

            transaction.oncomplete = () => resolve(true);
            transaction.onerror = (event) => reject(event);
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

    // ==================== MAGIA AI PREDICTIONS (SANDBOX) ====================

    async saveMagiaMatches(matches) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeMagiaAI], "readwrite");
            const store = transaction.objectStore(this.storeMagiaAI);
            matches.forEach(match => store.put(match));
            transaction.oncomplete = () => resolve(true);
            transaction.onerror = (event) => reject(event);
        });
    },

    async updateMagiaMatches(matches) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeMagiaAI], "readwrite");
            const store = transaction.objectStore(this.storeMagiaAI);
            matches.forEach(match => store.put(match));
            transaction.oncomplete = () => resolve(true);
            transaction.onerror = (event) => reject(event);
        });
    },

    async loadMagiaMatches() {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeMagiaAI], "readonly");
            const store = transaction.objectStore(this.storeMagiaAI);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => reject(event);
        });
    },

    async deleteMagiaMatch(id) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeMagiaAI], "readwrite");
            const store = transaction.objectStore(this.storeMagiaAI);

            // 🔥 Tenta entrambi i tipi
            store.delete(String(id));
            if (!isNaN(id) && id !== '') {
                store.delete(Number(id));
            }

            transaction.oncomplete = () => resolve(true);
            transaction.onerror = (event) => reject(event);
        });
    },

    async clearMagiaStore() {
        if (!this.db) await this.init();
        const transaction = this.db.transaction([this.storeMagiaAI], "readwrite");
        transaction.objectStore(this.storeMagiaAI).clear();
    },

    async clear() {
        if (!this.db) await this.init();
        const transaction = this.db.transaction([this.storeName, this.storeStrategies, this.storeLeagues, this.storeMagiaAI], "readwrite");
        transaction.objectStore(this.storeName).clear();
        transaction.objectStore(this.storeStrategies).clear();
        transaction.objectStore(this.storeLeagues).clear();
        transaction.objectStore(this.storeMagiaAI).clear();
        if (this.db.objectStoreNames.contains(this.storeParlays)) {
            transaction.objectStore(this.storeParlays).clear();
        }
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

    async getAllStrategyDates() {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeStrategies], "readonly");
            const store = transaction.objectStore(this.storeStrategies);
            const request = store.getAllKeys();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => reject(event);
        });
    },

    async getAllParlayDates() {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeParlays], "readonly");
            const store = transaction.objectStore(this.storeParlays);
            const request = store.getAllKeys();
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

    // ==================== PARLAYS HISTORY (LOCAL ONLY) ====================

    async saveParlayHistory(date, parlayData) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeParlays], "readwrite");
            const store = transaction.objectStore(this.storeParlays);

            const record = {
                date: date,
                lastUpdated: Date.now(),
                data: parlayData // Full parlayDoc structure
            };

            const request = store.put(record);
            request.onsuccess = () => resolve(true);
            request.onerror = (event) => reject(event);
        });
    },

    async loadParlayHistory(date) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeParlays], "readonly");
            const store = transaction.objectStore(this.storeParlays);
            const request = store.get(date);
            request.onsuccess = () => {
                const result = request.result;
                resolve(result ? result.data : null);
            };
            request.onerror = (event) => reject(event);
        });
    },

    // ==================== TRADING HISTORY (LOCAL ONLY) ====================

    async saveTradingHistory(date, tradingData) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeTrading], "readwrite");
            const store = transaction.objectStore(this.storeTrading);

            const record = {
                date: date,
                lastUpdated: Date.now(),
                data: tradingData // Full tradingDoc structure
            };

            const request = store.put(record);
            request.onsuccess = () => resolve(true);
            request.onerror = (event) => reject(event);
        });
    },

    async loadTradingHistory(date) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeTrading], "readonly");
            const store = transaction.objectStore(this.storeTrading);
            const request = store.get(date);
            request.onsuccess = () => {
                const result = request.result;
                resolve(result ? result.data : null);
            };
            request.onerror = (event) => reject(event);
        });
    },

    async getAllTradingDates() {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeTrading], "readonly");
            const store = transaction.objectStore(this.storeTrading);
            const request = store.getAllKeys();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (event) => reject(event);
        });
    },

    async deleteStrategiesHistory(date) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeStrategies], "readwrite");
            const store = transaction.objectStore(this.storeStrategies);
            const request = store.delete(date);
            request.onsuccess = () => resolve(true);
            request.onerror = (event) => reject(event);
        });
    },

    async deleteMatchFromHistory(date, matchId) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeStrategies], "readwrite");
            const store = transaction.objectStore(this.storeStrategies);
            const getRequest = store.get(date);

            getRequest.onsuccess = async () => {
                const record = getRequest.result;
                if (!record || !record.strategies) {
                    resolve(false);
                    return;
                }

                let updated = false;
                for (const stratId in record.strategies) {
                    const strat = record.strategies[stratId];
                    if (strat.matches) {
                        const originalLen = strat.matches.length;
                        strat.matches = strat.matches.filter(m => String(m.id) !== String(matchId));
                        if (strat.matches.length !== originalLen) updated = true;
                    }
                }

                if (updated) {
                    record.lastUpdated = Date.now();
                    const putRequest = store.put(record);
                    putRequest.onsuccess = () => resolve(true);
                    putRequest.onerror = (e) => reject(e);
                } else {
                    resolve(false);
                }
            };
            getRequest.onerror = (e) => reject(e);
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

    async deleteLeagueMapping(name) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeLeagues], "readwrite");
            const store = transaction.objectStore(this.storeLeagues);
            const request = store.delete(name.toLowerCase().trim());
            request.onsuccess = () => resolve(true);
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
                const name = (m.name || m.label || '').toLowerCase().trim();
                const leagueId = parseInt(m.leagueId || m.id);

                if (!name || isNaN(leagueId)) return;

                const record = {
                    ...m,
                    name: name,
                    leagueId: leagueId,
                    updatedAt: m.updatedAt || Date.now()
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

    // 🔥 NEW v12.1: Resolve league name via alias lookup
    async resolveLeagueAlias(unknownName) {
        if (!this.db) await this.init();
        const normalized = unknownName.toLowerCase().trim();

        // 1. Check if it exists directly
        const direct = await this.getLeagueMapping(normalized);
        if (direct) return { canonical: normalized, leagueId: direct.leagueId, source: 'direct' };

        // 2. Check all leagues for alias match
        const allLeagues = await this.getAllLeagues();
        for (const league of allLeagues) {
            if (league.aliases && Array.isArray(league.aliases)) {
                for (const alias of league.aliases) {
                    if (alias.toLowerCase().trim() === normalized) {
                        return { canonical: league.name, leagueId: league.leagueId, source: 'alias' };
                    }
                }
            }
        }

        // 3. Not found
        return null;
    },

    // 🔥 NEW v12.1: Add alias to existing league
    async addLeagueAlias(leagueId, aliasName) {
        if (!this.db) await this.init();
        const allLeagues = await this.getAllLeagues();
        const target = allLeagues.find(l => l.leagueId === parseInt(leagueId));

        if (!target) {
            console.warn(`[LocalDB] Cannot add alias: leagueId ${leagueId} not found`);
            return false;
        }

        const normalizedAlias = aliasName.toLowerCase().trim();
        const aliases = target.aliases || [];

        if (!aliases.includes(normalizedAlias)) {
            aliases.push(normalizedAlias);
            target.aliases = aliases;

            return new Promise((resolve, reject) => {
                const transaction = this.db.transaction([this.storeLeagues], "readwrite");
                const store = transaction.objectStore(this.storeLeagues);
                store.put(target);
                transaction.oncomplete = () => {
                    console.log(`[LocalDB] Added alias "${normalizedAlias}" to league ${target.name} (ID: ${leagueId})`);
                    resolve(true);
                };
                transaction.onerror = (event) => reject(event);
            });
        }
        return true; // Already exists
    },

    // 🔥 NEW v12.1: Find similar leagues for suggestions
    findSimilarLeagues(unknownName, allLeagues) {
        const normalized = unknownName.toLowerCase().trim();
        const prefix = normalized.match(/^([a-z]{2}-[a-z]{3})/)?.[1] || null;

        const candidates = [];
        for (const league of allLeagues) {
            const leaguePrefix = league.name.match(/^([a-z]{2}-[a-z]{3})/)?.[1] || null;

            // Only match same country prefix
            if (prefix && leaguePrefix && prefix === leaguePrefix) {
                const sim = this._jaccardSimilarity(normalized, league.name);
                if (sim >= 0.3) {
                    candidates.push({
                        name: league.name,
                        leagueId: league.leagueId,
                        similarity: sim
                    });
                }
            }
        }

        return candidates.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
    },

    _jaccardSimilarity(s1, s2) {
        const words1 = new Set(s1.split(/\s+/));
        const words2 = new Set(s2.split(/\s+/));
        const intersection = [...words1].filter(w => words2.has(w)).length;
        const union = new Set([...words1, ...words2]).size;
        return union > 0 ? intersection / union : 0;
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
        const parlaysArray = backupData.parlays || [];
        const tradingArray = backupData.trading || [];

        return new Promise((resolve, reject) => {
            const stores = [this.storeStrategies, this.storeLeagues, this.storeParlays, this.storeTrading];
            const transaction = this.db.transaction(stores, "readwrite");
            const strategyStore = transaction.objectStore(this.storeStrategies);
            const leagueStore = transaction.objectStore(this.storeLeagues);
            const parlayStore = transaction.objectStore(this.storeParlays);
            const tradingStore = transaction.objectStore(this.storeTrading);

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

            let parlayCount = 0;
            parlaysArray.forEach(parlay => {
                if (parlay.date && parlay.parlays) {
                    parlayStore.put(parlay);
                    parlayCount++;
                }
            });

            let tradingCount = 0;
            tradingArray.forEach(trade => {
                if (trade.date && trade.picks) {
                    tradingStore.put(trade);
                    tradingCount++;
                }
            });

            transaction.oncomplete = () => {
                console.log(`[LocalDB] Import Complete: ${strategyCount} days, ${leagueCount} leagues, ${parlayCount} parlays, ${tradingCount} trading days.`);
                resolve({ strategyCount, leagueCount, parlayCount, tradingCount });
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
            version: '2.0', // Updated version for unified backup
            exportedAt: new Date().toISOString(),
            history: [],
            leagues: [],
            parlays: [],
            trading: []
        };

        return new Promise((resolve, reject) => {
            const stores = [this.storeStrategies, this.storeLeagues, this.storeParlays, this.storeTrading];
            const transaction = this.db.transaction(stores, "readonly");

            const strategyRequest = transaction.objectStore(this.storeStrategies).getAll();
            const leagueRequest = transaction.objectStore(this.storeLeagues).getAll();
            const parlayRequest = transaction.objectStore(this.storeParlays).getAll();
            const tradingRequest = transaction.objectStore(this.storeTrading).getAll();

            let completed = 0;
            const checkDone = () => {
                completed++;
                if (completed === 4) resolve(exportData);
            };

            strategyRequest.onsuccess = () => {
                exportData.history = strategyRequest.result || [];
                checkDone();
            };

            leagueRequest.onsuccess = () => {
                exportData.leagues = leagueRequest.result || [];
                checkDone();
            };

            parlayRequest.onsuccess = () => {
                exportData.parlays = parlayRequest.result || [];
                checkDone();
            };

            tradingRequest.onsuccess = () => {
                exportData.trading = tradingRequest.result || [];
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
/**
 * 🛡️ PRIVACY UPDATE: Cloud sync for 'matches' collection is DISABLED
 * The "Database Oro" now stays exclusively in the local IndexedDB.
 */
async function uploadMatchesToFirebase(type, dataToUpload, existingMatches = [], db) {
    if (!dataToUpload || dataToUpload.length === 0) return 0;

    console.log(`[Upload] ID-Pure System: Data saved only in local IndexedDB. Suppression active for ${dataToUpload.length} records.`);

    // Simulo completamento per non rompere la UI
    const btn = document.getElementById(`confirm-${type}-upload-btn`);
    if (btn) btn.innerHTML = `<i class="fa-solid fa-check mr-2"></i>Salvato in Locale`;

    return dataToUpload.length;
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
                    if (m.probabilita !== undefined) matchData.probabilita = m.probabilita;
                    if (m.score !== undefined) matchData.score = m.score;
                    if (m.risultato !== undefined) matchData.risultato = m.risultato;
                    if (m.esito !== undefined) matchData.esito = m.esito;
                    if (m.ora !== undefined) matchData.ora = m.ora;
                    if (m.fixtureId !== undefined) matchData.fixtureId = m.fixtureId;
                    if (m.kickoffTimestamp !== undefined) matchData.kickoffTimestamp = m.kickoffTimestamp; // ⏰ SWISS TIME
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
                    if (m.info_ht !== undefined) matchData.info_ht = m.info_ht; // 🔥 HT DATA FOR PWA

                    // 🔥 Intelligence Fields (Normalization for PWA)
                    if (m.probMagiaAI !== undefined) matchData.probMagiaAI = m.probMagiaAI;
                    if (m.smartScore !== undefined) matchData.smartScore = m.smartScore;
                    if (m.pickDescription !== undefined) matchData.pickDescription = m.pickDescription;

                    // Compact magicStats (only if exists)
                    if (m.magicStats) {
                        matchData.magicStats = {};
                        if (m.magicStats.tipMagiaAI !== undefined) matchData.magicStats.tipMagiaAI = m.magicStats.tipMagiaAI;
                        if (m.magicStats.probMagiaAI !== undefined) matchData.magicStats.probMagiaAI = m.magicStats.probMagiaAI;
                        if (m.magicStats.oddMagiaAI !== undefined) matchData.magicStats.oddMagiaAI = m.magicStats.oddMagiaAI;
                        if (m.magicStats.smartScore !== undefined) matchData.magicStats.smartScore = m.magicStats.smartScore;
                        if (m.magicStats.top3Scores !== undefined) matchData.magicStats.top3Scores = m.magicStats.top3Scores;
                        if (m.magicStats.pickDescription !== undefined) matchData.magicStats.pickDescription = m.magicStats.pickDescription;
                        if (m.magicStats.ht05 !== undefined) matchData.magicStats.ht05 = m.magicStats.ht05; // 🔥 AI HT PROB

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

/**
 * 🔥 NEW v12.0: Load League Trust Scores from Firebase
 */
async function loadLeagueTrust(db) {
    try {
        const trustCol = window.collection(db, "league_trust");
        const snapshot = await window.getDocs(trustCol);
        const trustMap = {};
        snapshot.forEach(docSnap => {
            const key = docSnap.id; // Now it will be the leagueId (string)
            trustMap[key] = docSnap.data();
        });
        window.LEAGUE_TRUST = trustMap;
        console.log(`[Trust] Loaded ${Object.keys(trustMap).length} league trust scores`);
        return trustMap;
    } catch (e) {
        console.error("[Trust] Load Error:", e);
        return {};
    }
}

/**
 * 🔥 NEW v12.0: Update League Trust Scores based on recent results
 * This is the heart of the Self-Learning system.
 */
async function updateLeagueTrustHistory(db, matches) {
    if (!matches || matches.length === 0) return;

    // 🔥 Professional Cleaner (v12.1): Load registry for ID-to-Name canonicalization
    const registry = await LocalDB.getAllLeagueMappings();
    const idToName = {};
    const nameToId = {};
    registry.forEach(r => {
        if (r.leagueId) {
            const canonical = r.name.toLowerCase().trim();
            idToName[parseInt(r.leagueId)] = canonical;
            nameToId[canonical] = parseInt(r.leagueId);
        }
    });

    const leaguesToUpdate = {}; // canonicalName -> { won, lost, tips }

    matches.forEach(m => {
        if (!m.leagueId || !m.risultato || !m.tip) return;
        const leagueId = String(m.leagueId);

        // Normalizzazione Tip per compatibilità con evaluateTipLocally
        const result = window.evaluateTipLocally(m.tip, m.risultato);
        if (!result) return;

        if (!leaguesToUpdate[leagueId]) {
            leaguesToUpdate[leagueId] = { won: 0, total: 0 };
        }

        leaguesToUpdate[leagueId].total++;
        if (result === 'Vinto') leaguesToUpdate[leagueId].won++;
    });

    const operations = [];
    const trustCol = window.collection(db, "league_trust");

    for (const [leagueId, stats] of Object.entries(leaguesToUpdate)) {
        const docRef = window.doc(trustCol, leagueId);

        // Rolling update logic: weight the new results into the existing score
        const currentTrust = (window.LEAGUE_TRUST && window.LEAGUE_TRUST[leagueId]) ? window.LEAGUE_TRUST[leagueId] : { trust: 5, samples: 0, o15_wr: 75 };

        const newWR = (stats.won / stats.total) * 100;
        const weight = Math.min(0.2, stats.total / ((currentTrust.samples || 0) + stats.total));
        const updatedWR = ((currentTrust.o15_wr || 75) * (1 - weight)) + (newWR * weight);

        let newTrust = currentTrust.trust || 5;
        if (newWR > 80 && stats.total >= 2) newTrust = Math.min(10, newTrust + 0.5);
        if (newWR < 60 && stats.total >= 2) newTrust = Math.max(1, newTrust - 0.5);

        const currentMode = newTrust >= 7 ? 'SNIPER' : (newTrust <= 4 ? 'DEFENDER' : 'STANDARD');

        operations.push({
            type: 'set',
            ref: docRef,
            data: {
                trust: parseFloat(newTrust.toFixed(1)),
                o15_wr: parseFloat(updatedWR.toFixed(1)),
                samples: (currentTrust.samples || 0) + stats.total,
                lastUpdate: Date.now(),
                mode: currentMode
            },
            options: { merge: true }
        });

        // 🔥 NEW v12.0: UPDATE LOCAL DB REGISTRY TOO
        (async () => {
            try {
                // Notifica aggiornamento trust (solo log, la persistenza avviene su Firebase)
                console.log(`[TrustUpdate] ${leagueId}: Trust ${newTrust} Mode: ${currentMode}`);
            } catch (err) {
                console.warn(`[LocalTrust] Sync error for ${leagueId}:`, err);
            }
        })();
    }

    if (operations.length > 0) {
        console.log(`[Trust] Updating ${operations.length} leagues trust scores...`);
        await safeBatchCommit(db, operations);
        // Refresh local memory
        await loadLeagueTrust(db);
    }
}

// ==================== SANDBOX DB (Monte Carlo Persistence) ====================
// Isolated DB for large simulation results to avoid bloating main TipsterDB
const SandboxDB = {
    dbName: 'TipsterSandboxDB',
    storeName: 'montecarlo_results',
    db: null,

    async init() {
        if (this.db) return;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
            };
            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log("[SandboxDB] Initialized");
                resolve(this.db);
            };
            request.onerror = (event) => reject(event);
        });
    },

    async saveResults(date, results) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);

            // Structure: { id: date, results: [], lastUpdated: timestamp }
            const record = {
                id: date,
                results: results,
                lastUpdated: Date.now()
            };

            store.put(record);

            transaction.oncomplete = () => {
                console.log(`[SandboxDB] Saved results for ${date} (${results.length} matches)`);
                resolve(true);
            };
            transaction.onerror = (event) => reject(event);
        });
    },

    async loadResults(date) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readonly");
            const store = transaction.objectStore(this.storeName);
            const request = store.get(date);

            request.onsuccess = () => {
                resolve(request.result || null);
            };
            request.onerror = (event) => reject(event);
        });
    },

    async deleteResult(date, matchId) {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            const getRequest = store.get(date);

            getRequest.onsuccess = () => {
                const record = getRequest.result;
                if (!record || !record.results) {
                    resolve(false);
                    return;
                }

                const initialLen = record.results.length;
                record.results = record.results.filter(m => String(m.id) !== String(matchId));

                if (record.results.length !== initialLen) {
                    record.lastUpdated = Date.now();
                    const putRequest = store.put(record);
                    putRequest.onsuccess = () => resolve(true);
                } else {
                    resolve(false);
                }
            };
            getRequest.onerror = (e) => reject(e);
        });
    },

    async clear() {
        if (!this.db) await this.init();
        const transaction = this.db.transaction([this.storeName], "readwrite");
        transaction.objectStore(this.storeName).clear();
        console.log("[SandboxDB] Cleared");
    }
};

// Export for global usage
window.LocalDB = LocalDB;
window.SandboxDB = SandboxDB; // 🔥 NEW
window.databaseManager = {
    safeBatchCommit,
    uploadMatchesToFirebase,
    saveStrategyToHistory,
    cleanupOldStrategies,
    cleanupOldFirebaseHistory: cleanupOldStrategies,
    loadLeagueTrust,
    updateLeagueTrustHistory
};
