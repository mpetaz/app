import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, collection, query, where, getDocs, onSnapshot } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut, setPersistence, browserLocalPersistence, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";

// Firebase Config (Configured in init via window.firebaseConfig if present, or defaults)
const firebaseConfig = window.firebaseConfig;
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const functions = getFunctions(app);

// Global State
window.db = db;
window.setDoc = setDoc;
window.getDoc = getDoc;
window.doc = doc;
window.collection = collection;
window.query = query;
window.where = where;
window.getDocs = getDocs;
window.currentUser = null;
window.currentUserProfile = null;
window.strategiesData = null;
window.selectedMatches = [];
window.aiKnowledge = {};
window.globalStats = { total: 0, wins: 0, losses: 0, winrate: 0 };

let currentStrategyId = null;
let currentSortMode = 'score';
let isRegisterMode = false;
let warningStats = null;
let tradingFavorites = []; // IDs of favorite trading picks
let currentTradingDate = new Date().toISOString().split('T')[0];
let tradingUnsubscribe = null; // For real-time updates

// Auth Persistence
setPersistence(auth, browserLocalPersistence).catch(err => console.error('[Auth] Persistence error:', err));

// Secure Gemini Implementation
window.chatWithGemini = async (payload) => {
    try {
        const chatFn = httpsCallable(functions, 'chat');
        const result = await chatFn({
            contents: payload.contents,
            generationConfig: payload.generationConfig || { temperature: 0.7 }
        });
        return result;
    } catch (error) {
        console.error('[Eugenio] Proxy Error:', error);
        let msg = "Eugenio è stanco (troppe richieste). Riprova tra poco! ☕";
        if (error.code === 'unauthenticated') msg = "Accedi per parlare con Eugenio.";
        alert(msg);
        throw error;
    }
};

// ==================== UNIVERSAL CARD RENDERER ====================
window.createUniversalCard = function (match, index, stratId, options = {}) {
    // Detect Type
    const isMagia = (match.magicStats !== undefined) || (stratId && stratId.toLowerCase().includes('magia'));
    const isTrading = (match.strategy === 'LAY_DRAW' || match.strategy === 'BACK_OVER_25') || options.isTrading;
    const matchId = match.id || `${match.data}_${match.partita}`;
    const isFlagged = !isTrading ? (window.selectedMatches || []).some(sm => sm.id === matchId) : tradingFavorites.includes(matchId);

    // Style Configuration
    let headerClass = 'bg-gradient-to-r from-blue-900 via-indigo-900 to-blue-950';
    let headerIcon = '<i class="fa-solid fa-futbol"></i>';
    let headerTitle = 'Analisi Match';

    if (isMagia) {
        headerClass = 'bg-indigo-900';
        headerIcon = '<i class="fa-solid fa-microchip text-cyan-300"></i>';
        headerTitle = 'Magia AI Scanner';
    } else if (isTrading) {
        const isOver = match.strategy === 'BACK_OVER_25';
        headerClass = isOver ? 'bg-gradient-to-r from-purple-600 to-blue-600' : 'bg-gradient-to-r from-orange-500 to-red-500';
        headerIcon = isOver ? '📊' : '🎯';
        headerTitle = isOver ? 'Trading: BACK OVER 2.5' : 'Trading: LAY THE DRAW';
    }

    const card = document.createElement('div');
    card.className = `match-card rounded-xl shadow-lg fade-in mb-3 overflow-hidden bg-white border border-gray-100 relative ${isFlagged && isTrading ? 'ring-2 ring-emerald-500' : ''}`;

    // --- Header ---
    // If Live Trading, show specialized header
    let headerHTML = '';
    if (isTrading && options.detailedTrading && match.liveData) {
        const isLive = match.liveData.minute > 0;
        headerHTML = `
            <div class="${headerClass} p-3 flex justify-between items-center text-white">
                 <div class="flex items-center gap-2">
                    ${headerIcon}
                    <span class="font-bold text-sm tracking-wider uppercase">${headerTitle}</span>
                </div>
                <div class="flex items-center gap-2">
                    ${isLive ? '<span class="animate-pulse text-red-400 font-bold text-xs">● LIVE</span>' : ''}
                    <div class="text-xl font-black font-mono">${match.liveData.minute || 0}'</div>
                </div>
            </div>
        `;
    } else {
        headerHTML = `
            <div class="${headerClass} p-3 flex justify-between items-center text-white">
                <div class="flex items-center gap-2">
                    ${headerIcon}
                    <span class="font-bold text-sm tracking-wider uppercase">${headerTitle}</span>
                </div>
                <div class="flex items-center gap-2">
                    ${match.ora ? `<span class="text-xs bg-white/20 px-2 py-0.5 rounded font-bold">⏰ ${match.ora}</span>` : ''}
                </div>
            </div>
        `;
    }

    // --- Teams & Score ---
    const scoreDisplay = (isTrading && options.detailedTrading && match.liveData)
        ? `<div class="mt-1 text-2xl font-black text-gray-900 tracking-widest">${match.liveData.homeScore} - ${match.liveData.awayScore}</div>`
        : (match.risultato ? `<div class="mt-1 text-xl font-black text-gray-900">${match.risultato}</div>` : '');

    const teamsHTML = `
        <div class="p-4 pb-2 text-center">
            <div class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">${match.lega || 'Unknown League'}</div>
            <div class="text-lg font-black text-gray-800 leading-tight">${match.partita}</div>
            ${scoreDisplay}
        </div>
    `;

    // --- Primary Signal ---
    let primarySignalHTML = '';
    const ms = match.magicStats || {};

    if (isMagia) {
        const implied = ms.oddMagiaAI ? (1 / parseFloat(ms.oddMagiaAI)) * 100 : 0;
        const edge = (ms.confidence || 0) - implied;
        const isValueBet = edge > 10;
        primarySignalHTML = `
            <div class="flex justify-center mb-4 relative z-10">
                <div class="bg-indigo-50 border-2 border-indigo-200 rounded-2xl p-4 flex flex-col items-center min-w-[140px] shadow-sm relative overflow-visible group">
                     ${isValueBet ? `<div class="absolute -top-3 -right-3 animate-bounce z-20"><i class="fa-solid fa-gem text-blue-500 text-xl drop-shadow-md"></i></div>` : ''}
                     <span class="text-xs font-bold text-indigo-400 uppercase tracking-widest mb-1">Previsione IA</span>
                     <div class="text-3xl font-black text-indigo-900">${ms.tipMagiaAI || match.tip || '-'}</div>
                     ${ms.oddMagiaAI ? `<div class="text-sm font-bold text-indigo-500 mt-1">@ ${ms.oddMagiaAI}</div>` : ''}
                </div>
            </div>
        `;
    } else if (isTrading) {
        primarySignalHTML = `
            <div class="border-t border-b border-gray-100 py-3 mb-3 bg-gray-50 flex justify-around">
                <div class="text-center">
                    <div class="text-xs text-gray-400 font-bold uppercase">Azione</div>
                    <div class="font-black text-gray-800 text-lg">${match.tradingInstruction?.action || match.tip || '-'}</div>
                </div>
                <div class="text-center">
                    <div class="text-xs text-gray-400 font-bold uppercase">Entry</div>
                    <div class="font-black text-green-600 text-lg">${match.tradingInstruction?.entryRange ? match.tradingInstruction.entryRange.join('-') : '-'}</div>
                </div>
                <div class="text-center">
                    <div class="text-xs text-gray-400 font-bold uppercase">Exit</div>
                    <div class="font-black text-orange-500 text-lg">${match.tradingInstruction?.exitTarget || 'Auto'}</div>
                </div>
            </div>
        `;
    } else {
        primarySignalHTML = `
            <div class="flex justify-center mb-4">
                <div class="bg-gray-100 rounded-xl p-3 flex flex-col items-center min-w-[120px]">
                     <span class="text-[10px] font-bold text-gray-400 uppercase">Consiglio</span>
                     <div class="text-2xl font-black text-gray-800">${match.tip}</div>
                     ${match.quota ? `<div class="text-xs font-bold text-gray-500 bg-white px-2 py-0.5 rounded mt-1 shadow-sm">@${match.quota}</div>` : ''}
                </div>
            </div>
        `;
    }

    // --- Insights / detailedTrading ---
    let insightsHTML = '';

    // TRADING: Live Stats
    if (isTrading && options.detailedTrading && match.liveStats) {
        insightsHTML += `
            <div class="px-4 mb-3">
                <div class="grid grid-cols-3 gap-2 text-center text-xs bg-gray-50 p-2 rounded-lg">
                     <div>
                        <div class="text-gray-400 font-bold">POSSESSO</div>
                        <div class="font-black text-gray-800">${match.liveStats.possession?.home || 0}% - ${match.liveStats.possession?.away || 0}%</div>
                     </div>
                     <div>
                        <div class="text-gray-400 font-bold">TIRI</div>
                        <div class="font-black text-gray-800">${match.liveStats.shots?.home || 0} - ${match.liveStats.shots?.away || 0}</div>
                     </div>
                     <div>
                        <div class="text-gray-400 font-bold">XG</div>
                        <div class="font-black text-gray-800">${match.liveStats.xg?.home || 0} - ${match.liveStats.xg?.away || 0}</div>
                     </div>
                </div>
            </div>
        `;
    }

    // TRADING: Events Timeline
    if (isTrading && options.detailedTrading && match.events && match.events.length > 0) {
        insightsHTML += `
            <div class="px-4 mb-3">
                 <div class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Eventi Chiave</div>
                 <div class="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                    ${match.events.map(ev => `
                        <div class="flex-shrink-0 bg-white border border-gray-200 rounded px-2 py-1 text-[10px] flex items-center gap-1">
                            <span class="font-bold text-gray-500">${ev.minute}'</span>
                            <span class="font-bold text-gray-800">${ev.type === 'GOAL' ? '⚽' : (ev.type === 'RED_CARD' ? '🟥' : '🟨')}</span>
                        </div>
                    `).join('')}
                 </div>
            </div>
        `;
    }

    // 1X2 Prob Bar (Consistent AI Insight)
    if (ms.winHomeProb || ms.drawProb || ms.winAwayProb) {
        insightsHTML += `
            <div class="px-4 mb-4">
                <div class="bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <div class="flex justify-between items-end mb-2">
                        <span class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Probabilità AI</span>
                    </div>
                    <div class="flex h-2.5 rounded-full overflow-hidden mb-2 shadow-inner bg-slate-200">
                        <div class="h-full bg-indigo-500" style="width: ${ms.winHomeProb || 33}%"></div>
                        <div class="h-full bg-slate-300" style="width: ${ms.drawProb || 33}%"></div>
                        <div class="h-full bg-purple-500" style="width: ${ms.winAwayProb || 33}%"></div>
                    </div>
                    <div class="flex justify-between text-[10px] font-bold text-slate-500 px-1">
                        <div class="flex items-center gap-1"><div class="w-2 h-2 rounded-full bg-indigo-500"></div>1 (${Math.round(ms.winHomeProb || 0)}%)</div>
                        <div class="flex items-center gap-1"><div class="w-2 h-2 rounded-full bg-slate-300"></div>X (${Math.round(ms.drawProb || 0)}%)</div>
                        <div class="flex items-center gap-1"><div class="w-2 h-2 rounded-full bg-purple-500"></div>2 (${Math.round(ms.winAwayProb || 0)}%)</div>
                    </div>
                </div>
            </div>
        `;
    }

    // Signals Convergence
    if (isMagia && ms.topSignals && ms.topSignals.length > 0) {
        insightsHTML += `
            <div class="px-4 mb-4">
                 <div class="text-[9px] font-bold text-center text-gray-400 uppercase tracking-widest mb-2">Segnali Forti</div>
                 <div class="flex justify-center gap-2">
                    ${ms.topSignals.slice(0, 3).map(sig => `
                        <div class="bg-indigo-50 border border-indigo-100 rounded-lg px-2 py-1 text-center">
                            <div class="text-[9px] text-indigo-400 font-bold uppercase">${sig.label}</div>
                            <div class="text-xs font-black text-indigo-800">${sig.prob}%</div>
                        </div>
                    `).join('')}
                 </div>
            </div>
        `;
    }

    // Warnings (Standard Only)
    if (!isMagia && !isTrading && warningStats && STANDARD_STRATEGIES.includes(stratId)) {
        const volatile = warningStats.volatileLeagues?.find(l => l.lega === match.lega);
        if (volatile) {
            insightsHTML += `
                <div class="mx-4 mb-3 bg-red-50 border border-red-200 rounded-lg p-2 flex items-center gap-2">
                    <i class="fa-solid fa-triangle-exclamation text-red-500 text-xs"></i>
                    <div class="text-[10px] text-red-700 font-bold">Lega volatile (${volatile.volatility}% vol)</div>
                </div>
             `;
        }
    }

    // --- Footer ---
    const flagBtnHTML = isTrading
        ? `<button class="text-gray-400 hover:text-emerald-500 transition text-xl" onclick="toggleTradingFavorite('${matchId}')">
             <i class="${isFlagged ? 'fa-solid text-emerald-500' : 'fa-regular'} fa-bookmark"></i>
           </button>`
        : `<button class="flag-btn ${isFlagged ? 'flagged text-yellow-400' : 'text-gray-400'} hover:text-yellow-400 transition" onclick="toggleFlag('${matchId}')">
             ${isFlagged ? '<i class="fa-solid fa-star"></i>' : '<i class="fa-regular fa-star"></i>'}
           </button>`;

    const footerHTML = `
        <div class="bg-gray-50 p-2 border-t border-gray-100 flex justify-between items-center px-4">
             ${flagBtnHTML}
             ${options.showTime !== false && !isTrading ? '' : ''}
              ${isTrading ? '<span class="text-[10px] font-bold text-gray-400">TRADING</span>' : ''}
        </div>
    `;

    card.innerHTML = headerHTML + teamsHTML + primarySignalHTML + insightsHTML + footerHTML;
    return card;
};

// ==================== TRADING LOGIC ====================
window.initTradingPage = function () {
    // Navigation Listeners
    document.getElementById('trading-date-prev').addEventListener('click', () => {
        const d = new Date(currentTradingDate);
        d.setDate(d.getDate() - 1);
        currentTradingDate = d.toISOString().split('T')[0];
        loadTradingPicks(currentTradingDate);
    });

    document.getElementById('trading-date-next').addEventListener('click', () => {
        const d = new Date(currentTradingDate);
        d.setDate(d.getDate() + 1);
        currentTradingDate = d.toISOString().split('T')[0];
        loadTradingPicks(currentTradingDate);
    });

    // Initial Load
    loadTradingFavorites();
    loadTradingPicks(currentTradingDate);
};

window.loadTradingPicks = function (date) {
    if (tradingUnsubscribe) tradingUnsubscribe();

    // Update Date Display
    document.getElementById('trading-selected-date-display').textContent = formatDateLong(date);
    document.getElementById('trading-date-indicator').textContent = 'Caricamento...';

    // Listen for Realtime Updates
    tradingUnsubscribe = onSnapshot(doc(db, "daily_trading_picks", date), (docSnap) => {
        const container = document.getElementById('trading-cards-container');
        const emptyState = document.getElementById('trading-empty');
        container.innerHTML = '';

        if (docSnap.exists()) {
            const data = docSnap.data();
            const picks = data.picks || [];

            if (picks.length > 0) {
                emptyState.classList.add('hidden');
                document.getElementById('trading-date-indicator').textContent = `${picks.length} opportunità`;

                picks.forEach(pick => {
                    const card = window.createUniversalCard(pick, 0, null, { isTrading: true, detailedTrading: true });
                    container.appendChild(card);
                });
            } else {
                emptyState.classList.remove('hidden');
                document.getElementById('trading-date-indicator').textContent = 'Nessuna partita';
            }
        } else {
            emptyState.classList.remove('hidden');
            document.getElementById('trading-date-indicator').textContent = 'Nessuna partita';
        }
    }, (error) => {
        console.error("Trading Live Error", error);
    });
};

window.loadTradingFavorites = async function () {
    if (!window.currentUser) return;
    try {
        const docSnap = await getDoc(doc(db, "users", window.currentUser.uid, "data", "trading_favorites"));
        if (docSnap.exists()) {
            tradingFavorites = docSnap.data().ids || [];
            // Refresh visual state if current page is trading
            // (Simplest: just reload current view references if needed, but onSnapshot handles re-render mostly)
        }
    } catch (e) { console.error("Load Trading Favs Error", e); }
};

window.toggleTradingFavorite = async function (matchId) {
    if (!window.currentUser) return alert("Accedi per salvare");

    const idx = tradingFavorites.indexOf(matchId);
    if (idx >= 0) tradingFavorites.splice(idx, 1);
    else tradingFavorites.push(matchId);

    // Optimistic UI Update
    const btns = document.querySelectorAll(`button[onclick="toggleTradingFavorite('${matchId}')"] i`);
    btns.forEach(i => {
        i.className = idx >= 0 ? 'fa-regular fa-bookmark' : 'fa-solid fa-bookmark text-emerald-500';
    });

    try {
        await setDoc(doc(db, "users", window.currentUser.uid, "data", "trading_favorites"), {
            ids: tradingFavorites,
            updated: Date.now()
        });
    } catch (e) { alert("Errore salvataggio"); }

    // Also update "My Matches" > Trading section if visible
    if (window.renderTradingFavoritesInStarTab) window.renderTradingFavoritesInStarTab();
};

window.renderTradingFavoritesInStarTab = async function () {
    const container = document.getElementById('trading-favorites-container');
    const empty = document.getElementById('trading-favorites-empty');
    if (!container) return;

    container.innerHTML = '';

    if (tradingFavorites.length === 0) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    // Fetch details for favorites (This is tricky if we don't have them in memory)
    // For now, we only show them if they are in the Current Date loaded?
    // Or we need to fetch them.
    // Simplifying: Show simplified list or assume data is available.
    // Ideally, we store full object in favorites or fetch by ID. Here we just stored IDs.
    // User requested "Link Trading Favorites to Date" in history.
    // For now, let's just show a text list or simple retrieval if active.
}

// ==================== MAIN FUNCTIONS ====================
onAuthStateChanged(auth, async (user) => {
    if (user) {
        window.currentUser = user;
        await loadUserProfile(user.uid);
        if (typeof window.loadEugenioPrompt === 'function') window.loadEugenioPrompt();

        document.getElementById('loading-overlay').classList.add('hidden');
        document.getElementById('login-container').classList.add('hidden');
        document.getElementById('app-container').classList.remove('hidden');

        // Init logic
        await loadData();
        initTradingPage(); // Start trading listener

        // Navigation Handler
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = btn.dataset.page;
                window.showPage(page);
            });
        });

    } else {
        document.getElementById('login-container').classList.remove('hidden');
    }
});

async function loadUserProfile(uid) {
    try {
        const docSnap = await getDoc(doc(db, "users", uid));
        if (docSnap.exists()) {
            window.currentUserProfile = docSnap.data();
            const nick = window.currentUserProfile.name || 'Utente';
            document.getElementById('user-nickname-header').textContent = `Ciao, ${nick}! 👋`;
        }
    } catch (e) {
        console.error("Profile Error", e);
    }
}

async function loadData(dateToLoad = null) {
    const targetDate = dateToLoad || new Date().toISOString().split('T')[0];

    try {
        let strategiesDoc = await getDoc(doc(db, "daily_strategies", targetDate));

        if (!strategiesDoc.exists()) {
            strategiesDoc = await getDoc(doc(db, "system", "strategy_results")); // Fallback
        }

        if (strategiesDoc.exists()) {
            const data = strategiesDoc.data();
            const rawStrategies = data.strategies || data;

            const approved = ['all', 'winrate_80', 'italia', 'top_eu', 'cups', 'best_05_ht', '___magia_ai', 'over_2_5_ai'];
            window.strategiesData = {};

            Object.entries(rawStrategies).forEach(([id, strat]) => {
                if (strat && strat.name && (approved.includes(id) || id.includes('magia') || (strat.method === 'poisson'))) {
                    window.strategiesData[id] = strat;
                }
            });

            renderStrategies();
            if (window.updateDateDisplay) window.updateDateDisplay(targetDate, true);
        } else {
            console.warn("No data for date");
        }

        if (!dateToLoad && window.currentUser) {
            const userMatches = await getDoc(doc(db, "users", window.currentUser.uid, "data", "selected_matches"));
            if (userMatches.exists()) {
                window.selectedMatches = userMatches.data().matches || [];
                if (window.updateMyMatchesCount) window.updateMyMatchesCount();
            }
        }

        // Load Warning Stats for Standard
        const wStats = await getDoc(doc(db, "system", "warning_stats"));
        if (wStats.exists()) warningStats = wStats.data();

        await renderStats();

    } catch (e) {
        console.error("Load Data Error", e);
    }
}

async function renderStats() {
    try {
        // Read pre-calculated stats from system/global_stats (populated by admin)
        const statsDoc = await getDoc(doc(db, "system", "global_stats"));

        if (statsDoc.exists()) {
            const stats = statsDoc.data();

            // Update Global Stats for AI
            window.globalStats = {
                total: stats.total || 0,
                wins: stats.wins || 0,
                losses: stats.losses || 0,
                winrate: stats.winrate || 0
            };

            document.getElementById('stat-total').textContent = stats.total || 0;
            document.getElementById('stat-wins').textContent = stats.wins || 0;
            document.getElementById('stat-losses').textContent = stats.losses || 0;
            document.getElementById('stat-winrate').textContent = (stats.winrate || 0) + '%';
            document.getElementById('last-update').textContent = formatDateLong(stats.lastUpdate || new Date().toISOString().split('T')[0]);
        } else {
            console.warn('[Stats] No global_stats found in system collection');
            // Set defaults
            document.getElementById('stat-total').textContent = '0';
            document.getElementById('stat-wins').textContent = '0';
            document.getElementById('stat-losses').textContent = '0';
            document.getElementById('stat-winrate').textContent = '0%';
            document.getElementById('last-update').textContent = formatDateLong(new Date().toISOString().split('T')[0]);
        }
    } catch (e) {
        console.error('Error loading stats:', e);
        // Set defaults on error
        document.getElementById('stat-total').textContent = '0';
        document.getElementById('stat-wins').textContent = '0';
        document.getElementById('stat-losses').textContent = '0';
        document.getElementById('stat-winrate').textContent = '0%';
        document.getElementById('last-update').textContent = formatDateLong(new Date().toISOString().split('T')[0]);
    }
}

function renderStrategies() {
    const container = document.getElementById('strategies-grid');
    if (!container) return;
    container.innerHTML = '';

    const descriptions = {
        all: 'Tutte le partite.',
        winrate_80: 'Only Top Winrate > 80%',
        italia: 'Serie A + B',
        magic_ai: 'AI Powered Analysis'
    };

    const premium = [];
    const standard = [];
    const STANDARD_STRATEGIES = ['all', 'italia', 'top_eu', 'cups', 'best_05_ht'];

    Object.entries(window.strategiesData).forEach(([id, strat]) => {
        if (STANDARD_STRATEGIES.includes(id)) standard.push({ id, strat });
        else premium.push({ id, strat });
    });

    if (premium.length) {
        const sec = document.createElement('div');
        sec.className = 'col-span-full mb-2';
        sec.innerHTML = '<div class="text-sm font-bold text-purple-300">✨ PREMIUM STRATEGIES</div>';
        container.appendChild(sec);
        premium.forEach(x => container.appendChild(createStrategyBtn(x.id, x.strat, true)));
    }

    if (standard.length) {
        const sec = document.createElement('div');
        sec.className = 'col-span-full mt-4 mb-2';
        sec.innerHTML = '<div class="text-sm font-bold text-blue-300">📂 STANDARD STRATEGIES</div>';
        container.appendChild(sec);
        standard.forEach(x => container.appendChild(createStrategyBtn(x.id, x.strat, false)));
    }
}

function createStrategyBtn(id, strat, isPremium) {
    const btn = document.createElement('button');
    const isMagic = id.includes('magia');
    btn.className = `strategy-btn ${isMagic ? 'magic-ai' : ''} text-white rounded-xl p-4 shadow-lg w-full text-left relative overflow-hidden`;
    btn.onclick = () => window.showRanking(id, strat);

    btn.innerHTML = `
        <div class="relative z-10">
            ${isPremium ? '<span class="text-[10px] bg-white/20 px-2 py-0.5 rounded font-black uppercase mb-2 inline-block">Pro</span>' : ''}
            <div class="text-xl font-bold">${strat.name}</div>
            <div class="text-xs opacity-70">${strat.totalMatches || strat.matches?.length || 0} Matches</div>
        </div>
        <div class="absolute right-[-10px] bottom-[-10px] text-6xl opacity-20 rotate-12">
            ${isMagic ? '🪄' : '⚽'}
        </div>
    `;
    return btn;
}

window.showRanking = function (stratId, strat, sortMode = 'score') {
    currentStrategyId = stratId;
    const container = document.getElementById('matches-container');
    document.getElementById('strategy-title').textContent = strat.name;

    container.innerHTML = '';

    if (!strat.matches || strat.matches.length === 0) {
        container.innerHTML = '<div class="text-center py-10 text-gray-400">Nessuna partita.</div>';
    } else {
        const sorted = [...strat.matches].sort((a, b) => {
            if (sortMode === 'time') return (a.ora || '').localeCompare(b.ora || '');
            return (b.score || 0) - (a.score || 0);
        });

        sorted.forEach((m, idx) => {
            container.appendChild(window.createUniversalCard(m, idx, stratId));
        });
    }

    window.showPage('ranking');
}

window.toggleFlag = async function (matchId) {
    let foundMatch = null;

    // Search in all loaded strategies
    if (window.strategiesData) {
        Object.values(window.strategiesData).forEach(s => {
            const matches = s.matches || (Array.isArray(s) ? s : []); // Handle different structures
            const m = matches.find(x => {
                const id = x.id || `${x.data}_${x.partita}`;
                return id === matchId;
            });
            if (m) foundMatch = m;
        });
    }

    // Fallback: Check if already in selectedMatches
    if (!foundMatch) {
        foundMatch = window.selectedMatches.find(m => {
            const id = m.id || `${m.data}_${m.partita}`;
            return id === matchId;
        });
    }

    if (foundMatch) {
        // Ensure ID is consistent
        const consistentId = foundMatch.id || `${foundMatch.data}_${foundMatch.partita}`;

        const idx = window.selectedMatches.findIndex(m => (m.id || `${m.data}_${m.partita}`) === consistentId);

        if (idx >= 0) {
            window.selectedMatches.splice(idx, 1);
            // Removed alert("Removed from Favorites");
        } else {
            window.selectedMatches.push({ ...foundMatch, id: consistentId });
            // Removed alert("Added to Favorites");
        }

        if (window.updateMyMatchesCount) window.updateMyMatchesCount();

        // Update Firebase
        if (window.currentUser) {
            try {
                await setDoc(doc(db, "users", window.currentUser.uid, "data", "selected_matches"), {
                    matches: window.selectedMatches,
                    updated: Date.now()
                });
            } catch (e) { console.error("Error saving favorites:", e); }
        } else {
            alert("Accedi per salvare i preferiti!");
        }

        // Update UI buttons immediately
        const btns = document.querySelectorAll(`button[onclick="toggleFlag('${matchId}')"]`);
        btns.forEach(b => {
            // Reset classes
            b.className = "flag-btn transition hover:text-yellow-400 text-xl";
            if (idx >= 0) {
                // It was removed -> now inactive
                b.classList.add("text-gray-400");
                b.innerHTML = '<i class="fa-regular fa-star"></i>';
            } else {
                // It was added -> now active
                b.classList.add("flagged", "text-yellow-400");
                b.innerHTML = '<i class="fa-solid fa-star"></i>';
            }
        });
    } else {
        console.error("Match not found for ID:", matchId);
    }
};

window.showPage = function (pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${pageId}`).classList.add('active');
    window.scrollTo(0, 0);
};

window.updateMyMatchesCount = function () {
    const badge = document.getElementById('my-matches-badge');
    const count = window.selectedMatches.length;
    if (badge) {
        badge.textContent = count;
        badge.classList.toggle('hidden', count === 0);
    }
};

window.formatDateLong = function (str) {
    if (!str) return '';
    const d = new Date(str);
    return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
};

const STANDARD_STRATEGIES = ['all', 'italia', 'top_eu', 'cups', 'best_05_ht'];

console.log('[App] Logic Initialized.');
