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

    // --- Footer ---
    // Moved Flag Button to Header

    // Header Generation with Star
    const flagBtnHTML = isTrading
        ? `<button data-match-id="${matchId}" class="text-white/70 hover:text-white transition text-xl bg-white/10 w-8 h-8 rounded-full flex items-center justify-center backdrop-blur-sm" onclick="toggleTradingFavorite('${matchId}'); event.stopPropagation();">
             <i class="${isFlagged ? 'fa-solid text-emerald-300' : 'fa-regular'} fa-bookmark"></i>
           </button>`
        : `<button data-match-id="${matchId}" class="flag-btn ${isFlagged ? 'flagged text-yellow-300' : 'text-white/60'} hover:text-yellow-300 transition text-xl ml-2" onclick="toggleFlag('${matchId}'); event.stopPropagation();">
             ${isFlagged ? '<i class="fa-solid fa-star drop-shadow-md"></i>' : '<i class="fa-regular fa-star"></i>'}
           </button>`;

    let headerHTML = '';
    if (isTrading && options.detailedTrading && match.liveData) {
        const isLive = match.liveData.minute > 0;
        headerHTML = `
            <div class="${headerClass} p-3 flex justify-between items-center text-white relative">
                 <div class="flex items-center gap-2">
                    ${headerIcon}
                    <span class="font-bold text-sm tracking-wider uppercase">${headerTitle}</span>
                </div>
                <div class="flex items-center gap-3">
                    <div class="flex items-center gap-2">
                        ${isLive ? '<span class="animate-pulse text-red-400 font-bold text-xs">● LIVE</span>' : ''}
                        <div class="text-xl font-black font-mono">${match.liveData.minute || 0}'</div>
                    </div>
                    ${flagBtnHTML}
                </div>
            </div>
        `;
    } else {
        headerHTML = `
            <div class="${headerClass} p-3 flex justify-between items-center text-white relative">
                <div class="flex items-center gap-2">
                    ${headerIcon}
                    <span class="font-bold text-sm tracking-wider uppercase">${headerTitle}</span>
                </div>
                <div class="flex items-center gap-2">
                    ${match.ora ? `<span class="text-xs bg-white/20 px-2 py-0.5 rounded font-bold">⏰ ${match.ora}</span>` : ''}
                    ${flagBtnHTML}
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
            <div class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1 truncate">${match.lega || 'Unknown League'}</div>
            <div class="text-lg font-black text-gray-800 leading-tight mb-1">${match.partita}</div>
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
            <div class="border-t border-b border-gray-100 py-2 mb-3 bg-gray-50 grid grid-cols-3 gap-1 px-1">
                <div class="text-center p-1">
                    <div class="text-[10px] text-gray-400 font-bold uppercase mb-1">Azione</div>
                    <div class="font-black text-gray-800 text-sm leading-tight">${match.tradingInstruction?.action || match.tip || '-'}</div>
                </div>
                <div class="text-center p-1 border-l border-r border-gray-200">
                    <div class="text-[10px] text-gray-400 font-bold uppercase mb-1">Entry</div>
                    <div class="font-black text-green-600 text-sm">${match.tradingInstruction?.entryRange ? match.tradingInstruction.entryRange.join('-') : '-'}</div>
                </div>
                <div class="text-center p-1">
                    <div class="text-[10px] text-gray-400 font-bold uppercase mb-1">Exit</div>
                    <div class="font-black text-orange-500 text-xs leading-tight">${match.tradingInstruction?.exitTarget || 'Auto'}</div>
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
                <div class="grid grid-cols-3 gap-2 text-center text-xs bg-gray-50 p-2 rounded-lg border border-gray-100">
                     <div>
                        <div class="text-[10px] text-gray-400 font-bold uppercase">Possesso</div>
                        <div class="font-black text-gray-800 text-xs">${match.liveStats.possession?.home || 0}% - ${match.liveStats.possession?.away || 0}%</div>
                     </div>
                     <div>
                        <div class="text-[10px] text-gray-400 font-bold uppercase">Tiri</div>
                        <div class="font-black text-gray-800 text-xs">${match.liveStats.shots?.home || 0} - ${match.liveStats.shots?.away || 0}</div>
                     </div>
                     <div>
                        <div class="text-[10px] text-gray-400 font-bold uppercase">XG</div>
                        <div class="font-black text-gray-800 text-xs">${match.liveStats.xg?.home || 0} - ${match.liveStats.xg?.away || 0}</div>
                     </div>
                </div>
            </div>
        `;
    }

    // TRADING: Events Timeline
    if (isTrading && options.detailedTrading && match.events && match.events.length > 0) {
        insightsHTML += `
            <div class="px-4 mb-3">
                 <div class="text-[9px] font-bold text-gray-300 uppercase tracking-widest mb-1">Timeline</div>
                 <div class="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                    ${match.events.map(ev => `
                        <div class="flex-shrink-0 bg-white border border-gray-100 rounded px-1.5 py-0.5 text-[10px] flex items-center gap-1 shadow-sm">
                            <span class="font-bold text-gray-400">${ev.minute}'</span>
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

    // --- Footer is now simpler without the Flag Button ---
    const footerHTML = `
        <div class="bg-gray-50 p-2 border-t border-gray-100 flex justify-end items-center px-4">
              ${isTrading ? '<span class="text-[9px] font-bold text-gray-300 uppercase tracking-widest">Trading Pick</span>' : '<span class="text-[9px] font-bold text-gray-300 uppercase tracking-widest">Standard Pick</span>'}
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

    // Also unsubscribe from signals if active
    if (window.signalsUnsubscribe) {
        window.signalsUnsubscribe();
        window.signalsUnsubscribe = null;
    }

    // Update Date Display
    document.getElementById('trading-selected-date-display').textContent = formatDateLong(date);
    document.getElementById('trading-date-indicator').textContent = 'Caricamento...';

    // 1. Listen for Daily Picks
    tradingUnsubscribe = onSnapshot(doc(db, "daily_trading_picks", date), (docSnap) => {
        if (!docSnap.exists()) {
            renderTradingCards([], {});
            document.getElementById('trading-date-indicator').textContent = 'Nessuna partita';
            return;
        }

        const data = docSnap.data();
        const picks = data.picks || [];

        // 2. Fetch Live Signals (Realtime)
        // We listen to the entire collection or query by date if possible. 
        // For simplicity and to match old logic, we'll listen to the collection but filtered could be better.
        // However, the ID matching happens on client.

        if (window.signalsUnsubscribe) window.signalsUnsubscribe();

        window.signalsUnsubscribe = onSnapshot(collection(db, "trading_signals"), (signalsSnap) => {
            const signalsMap = {};
            signalsSnap.forEach(doc => {
                signalsMap[doc.id] = doc.data();
            });

            // Merge functionality
            const mergedPicks = picks.map(pick => {
                const pickId = window.getTradingPickId(pick.partita);
                // Try direct match or fuzzy match logic if needed, but ID should be consistent now
                // Also try "trading_" + clean name
                let sig = signalsMap[pickId];

                // Fallback matching if ID format differs slightly
                if (!sig) {
                    // Try to find by partial match on name
                    const cleanPickName = pick.partita.toLowerCase().replace(/[^a-z]/g, "");
                    for (const sid in signalsMap) {
                        if (sid.includes(cleanPickName)) {
                            sig = signalsMap[sid];
                            break;
                        }
                    }
                }

                if (sig) {
                    return { ...pick, ...sig, id: pickId }; // Merge signal data (live, currentSignal, etc)
                }
                return { ...pick, id: pickId };
            });

            renderTradingCards(mergedPicks);

            if (mergedPicks.length > 0) {
                document.getElementById('trading-date-indicator').textContent = `${mergedPicks.length} opportunità`;
                document.getElementById('trading-empty').classList.add('hidden');
            } else {
                document.getElementById('trading-date-indicator').textContent = 'Nessuna partita';
                document.getElementById('trading-empty').classList.remove('hidden');
            }

        });

    }, (error) => {
        console.error("Trading Live Error", error);
        document.getElementById('trading-date-indicator').textContent = 'Errore caricamento';
    });
};

function renderTradingCards(picks) {
    const container = document.getElementById('trading-cards-container');
    container.innerHTML = '';

    if (picks.length === 0) {
        document.getElementById('trading-empty').classList.remove('hidden');
        return;
    }

    document.getElementById('trading-empty').classList.add('hidden');

    picks.forEach(pick => {
        // Pass "detailedTrading: true" to ensure live header is rendered
        // The merged object 'pick' now contains liveData from trading_signals!
        const card = window.createUniversalCard(pick, 0, null, { isTrading: true, detailedTrading: true });
        container.appendChild(card);
    });
}

// Helper to generate consistent Trading Pick IDs (Matches backend logic)
window.getTradingPickId = function (partita) {
    const cleanName = (partita || "").toLowerCase().replace(/[^a-z]/g, "");
    return `trading_${cleanName}`;
};

window.loadTradingFavorites = async function () {
    if (!window.currentUser) return;
    try {
        const favDoc = await getDoc(doc(db, "user_favorites", window.currentUser.uid));
        if (favDoc.exists()) {
            const rawFavorites = favDoc.data().tradingPicks || [];
            window.tradingFavorites = [...new Set(rawFavorites)];

            console.log('[Trading] Favorites loaded (Total History):', window.tradingFavorites.length);

            // We do NOT update the count here yet, because we don't know how many are active today.
            // activeTradingFavoritesCount will be set by renderTradingFavoritesInStarTab when it runs.
            // But we can trigger a render if we are on the star tab.
            if (document.getElementById('page-my-matches')?.classList.contains('active')) {
                window.renderTradingFavoritesInStarTab();
            } else {
                // Initial fallback: treat all as active until proven otherwise, OR 0.
                // Better to wait for render.
                window.updateMyMatchesCount();
            }
        }
    } catch (e) { console.error("Load Trading Favs Error", e); }
};

window.toggleTradingFavorite = async function (matchId) {
    if (!window.currentUser) return alert("Accedi per salvare");

    const idx = tradingFavorites.indexOf(matchId);
    if (idx >= 0) {
        tradingFavorites.splice(idx, 1);
        console.log('[Trading] Removed from favorites:', matchId);
    } else {
        tradingFavorites.push(matchId);
        console.log('[Trading] Added to favorites:', matchId);
    }

    // Update UI immediately (Optimistic)
    const btns = document.querySelectorAll(`button[data-match-id="${matchId}"]`);
    btns.forEach(b => {
        const icon = b.querySelector('i');
        if (icon) {
            // If we just removed it (idx >= 0), it's no longer favorited -> regular
            // If we just added it (idx < 0), it IS favorited -> solid
            const isFav = idx === -1; // -1 means it wasn't there, so we added it
            icon.className = isFav ? 'fa-solid fa-bookmark text-emerald-300' : 'fa-regular fa-bookmark';
        }
    });

    // Re-render star tab if active to update the list and active count
    if (window.renderTradingFavoritesInStarTab) {
        await window.renderTradingFavoritesInStarTab();
    }
    window.updateMyMatchesCount();

    try {
        await setDoc(doc(db, "user_favorites", window.currentUser.uid), {
            tradingPicks: tradingFavorites,
            updatedAt: new Date().toISOString()
        }, { merge: true });
    } catch (e) { alert("Errore salvataggio"); }
};

window.renderTradingFavoritesInStarTab = async function () {
    const container = document.getElementById('trading-favorites-container');
    const emptyState = document.getElementById('trading-favorites-empty');
    if (!container) return;

    container.innerHTML = '';

    try {
        if (!window.currentUser) {
            if (emptyState) emptyState.classList.remove('hidden');
            window.activeTradingFavoritesCount = 0;
            window.updateMyMatchesCount();
            return;
        }

        // Fetch user's trading favorites
        const favDoc = await getDoc(doc(db, "user_favorites", window.currentUser.uid));
        if (!favDoc.exists() || !favDoc.data().tradingPicks || favDoc.data().tradingPicks.length === 0) {
            if (emptyState) emptyState.classList.remove('hidden');
            window.activeTradingFavoritesCount = 0;
            window.updateMyMatchesCount();
            return;
        }

        const tradingPickIds = favDoc.data().tradingPicks || [];

        // Get daily picks for today to filter favorites
        const today = new Date().toISOString().split('T')[0];
        const tradingDailyDoc = await getDoc(doc(db, "daily_trading_picks", today));
        let dailyPicksForDate = [];
        if (tradingDailyDoc.exists()) {
            dailyPicksForDate = tradingDailyDoc.data().picks || [];
        }

        if (dailyPicksForDate.length === 0) {
            console.log('[TradingFavorites] No trading picks for today');
            if (emptyState) emptyState.classList.remove('hidden');
            window.activeTradingFavoritesCount = 0;
            window.updateMyMatchesCount();
            return;
        }

        // Get the IDs of the matches for today
        const dailyPickIds = dailyPicksForDate.map(p => window.getTradingPickId(p.partita));

        // Filter user's global favorites by what is active TODAY
        const activeFavoriteIds = tradingPickIds.filter(id => dailyPickIds.includes(id));

        // UPDATE GLOBAL COUNT
        window.activeTradingFavoritesCount = activeFavoriteIds.length;
        window.updateMyMatchesCount();

        if (activeFavoriteIds.length === 0) {
            console.log('[TradingFavorites] None of user favorites are active today');
            if (emptyState) emptyState.classList.remove('hidden');
            return;
        }

        if (emptyState) emptyState.classList.add('hidden');

        // Fetch Live Signals
        const signalsSnapshot = await getDocs(collection(db, "trading_signals"));
        const signalsMap = {};
        signalsSnapshot.forEach(doc => {
            signalsMap[doc.id] = doc.data();
        });

        // Render favorited trading picks using daily picks data merged with signals
        activeFavoriteIds.forEach(favId => {
            // Find the matching pick from daily picks
            let pick = dailyPicksForDate.find(p => window.getTradingPickId(p.partita) === favId);
            if (!pick) return;

            // Merge with live signal if available
            let sig = signalsMap[favId];
            if (!sig) {
                // Fallback fuzzy match
                const cleanName = pick.partita.toLowerCase().replace(/[^a-z]/g, "");
                for (const sid in signalsMap) {
                    if (sid.includes(cleanName)) {
                        sig = signalsMap[sid];
                        break;
                    }
                }
            }
            if (sig) {
                pick = { ...pick, ...sig };
            }

            // Create card with detailedTrading option to show live header
            const card = window.createUniversalCard(pick, 0, null, { isTrading: true, detailedTrading: true });
            container.appendChild(card);
        });

        console.log(`[TradingFavorites] Rendered ${activeFavoriteIds.length} favorites`);

    } catch (e) {
        console.error('[TradingFavorites] Error loading:', e);
        if (emptyState) emptyState.classList.remove('hidden');
        window.activeTradingFavoritesCount = 0; // Reset on error
        window.updateMyMatchesCount();
    }
};

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

// Event Listeners for Strategy & Ranking Pages
const backToStrategiesBtn = document.getElementById('back-to-strategies');
if (backToStrategiesBtn) {
    backToStrategiesBtn.addEventListener('click', () => window.showPage('strategies'));
}

const sortByScoreBtn = document.getElementById('sort-by-score');
if (sortByScoreBtn) {
    sortByScoreBtn.addEventListener('click', () => {
        if (currentStrategyId && window.strategiesData[currentStrategyId]) {
            window.showRanking(currentStrategyId, window.strategiesData[currentStrategyId], 'score');
        }
    });
}

const sortByTimeBtn = document.getElementById('sort-by-time');
if (sortByTimeBtn) {
    sortByTimeBtn.addEventListener('click', () => {
        if (currentStrategyId && window.strategiesData[currentStrategyId]) {
            window.showRanking(currentStrategyId, window.strategiesData[currentStrategyId], 'time');
        }
    });
}

// My Matches Sorting
const myMatchesSortScore = document.getElementById('my-matches-sort-score');
if (myMatchesSortScore) {
    myMatchesSortScore.addEventListener('click', () => {
        // Implement logic if needed, currently reusing logic or re-rendering my matches
        // For simplicity, we can just re-render if we had a render function exposed
    });
}

// Additional Listeners
const deleteAllMatchesBtn = document.getElementById('delete-all-matches-btn');
if (deleteAllMatchesBtn) {
    deleteAllMatchesBtn.addEventListener('click', async () => {
        if (confirm("Sei sicuro di voler cancellare tutte le partite salvate?")) {
            window.selectedMatches = [];
            window.updateMyMatchesCount();
            // Remove all trading favorites too if desired, or just betting matches
            // User requested "Delete All" to clear both betting and trading in previous session.
            // Let's clear both for consistency with that request.
            try {
                tradingFavorites = [];
                await setDoc(doc(db, "users", window.currentUser.uid, "data", "trading_favorites"), { ids: [], updated: Date.now() });
                await setDoc(doc(db, "users", window.currentUser.uid, "data", "selected_matches"), { matches: [], updated: Date.now() });
                alert("Tutti i preferiti cancellati.");
                // Refresh UI
                const starBtns = document.querySelectorAll('.fa-star.fa-solid'); // Reset stars
                starBtns.forEach(el => el.parentElement.innerHTML = '<i class="fa-regular fa-star"></i>');
                if (window.renderTradingFavoritesInStarTab) window.renderTradingFavoritesInStarTab();
            } catch (e) { console.error(e); }
        }
    });
}

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
    const STANDARD_STRATEGIES = ['all', 'italia', 'top_eu', 'cups', 'best_05_ht', 'winrate_80'];

    Object.entries(window.strategiesData).forEach(([id, strat]) => {
        if (STANDARD_STRATEGIES.includes(id)) standard.push({ id, strat });
        else premium.push({ id, strat });
    });

    if (premium.length) {
        const sec = document.createElement('div');
        sec.className = 'col-span-full mb-2';
        sec.innerHTML = '<div class="text-sm font-bold text-purple-300">✨ Strategie AI</div>';
        container.appendChild(sec);
        premium.forEach(x => container.appendChild(createStrategyBtn(x.id, x.strat, true)));
    }

    if (standard.length) {
        const sec = document.createElement('div');
        sec.className = 'col-span-full mt-4 mb-2';
        sec.innerHTML = '<div class="text-sm font-bold text-blue-300">📂 Strategie Fisse</div>';
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

        // Update UI using data attribute
        const btns = document.querySelectorAll(`button[data-match-id="${matchId}"]`);
        btns.forEach(b => {
            // Reset classes
            b.className = "flag-btn transition hover:text-yellow-300 text-xl ml-2";

            if (idx >= 0) {
                b.classList.add("text-white/60");
                b.innerHTML = '<i class="fa-regular fa-star"></i>';
            } else {
                b.classList.add("flagged", "text-yellow-300");
                b.innerHTML = '<i class="fa-solid fa-star drop-shadow-md"></i>';
            }
        });
    } else {
        console.error("Match not found for ID:", matchId);
    }
};

// Live Refresh Loop
let tradingLiveInterval = null;

function startTradingLiveRefresh() {
    if (tradingLiveInterval) clearInterval(tradingLiveInterval);
    tradingLiveInterval = setInterval(() => {
        // If we are on trading page, refresh main list
        if (document.getElementById('page-trading')?.classList.contains('active')) {
            if (window.currentTradingDate) window.loadTradingPicks(window.currentTradingDate);
        }
        // If we are on star page, refresh favorites
        if (document.getElementById('page-my-matches')?.classList.contains('active') ||
            document.getElementById('page-star')?.classList.contains('active')) {
            if (window.renderTradingFavoritesInStarTab) window.renderTradingFavoritesInStarTab();
        }
    }, 60000);
}

window.showPage = function (pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${pageId}`).classList.add('active');
    window.scrollTo(0, 0);

    // Render My Matches when navigating to star tab
    if (pageId === 'star' || pageId === 'my-matches') {
        window.showMyMatches();
        if (window.renderTradingFavoritesInStarTab) window.renderTradingFavoritesInStarTab();
        startTradingLiveRefresh();
    } else if (pageId === 'trading') {
        startTradingLiveRefresh();
    } else {
        if (tradingLiveInterval) clearInterval(tradingLiveInterval);
    }
};

window.updateMyMatchesCount = function () {
    const navBtn = document.querySelector('[data-page="star"]') || document.querySelector('[data-page="my-matches"]');
    if (!navBtn) return;

    let countBadge = navBtn.querySelector('.count-badge');

    // Total = Betting favorites + Trading favorites  
    const bettingCount = (window.selectedMatches || []).length;
    // Use active count calculated by render function if available, otherwise 0 or raw length if preferred
    // The backup used activeTradingFavoritesCount || 0. We stick to that.
    const tradingCount = window.activeTradingFavoritesCount || 0;

    // Fallback: If 0 but we have favorites and haven't rendered yet, it might be confusing.
    // But since we trigger render on load if on page, or show 0 until viewed, this is safer than showing 19.

    const totalCount = bettingCount + tradingCount;

    if (totalCount > 0) {
        if (!countBadge) {
            countBadge = document.createElement('span');
            countBadge.className = 'count-badge absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold z-50';
            navBtn.style.position = 'relative';
            navBtn.appendChild(countBadge);
        }
        countBadge.textContent = totalCount;
    } else if (countBadge) {
        countBadge.remove();
    }
};

// Only renders Betting Favorites
window.showMyMatches = function (sortMode = 'score') {
    const container = document.getElementById('my-matches-container');
    if (!container) return;

    container.innerHTML = '';

    const bettingMatches = window.selectedMatches || [];

    // Betting Favorites Section
    if (bettingMatches.length === 0) {
        container.innerHTML = '<div class="text-center text-gray-300 py-4 opacity-50">Nessun pronostico salvato</div>';
    } else {
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'mb-4';
        sectionHeader.innerHTML = '<div class="text-sm font-bold text-purple-300 flex items-center gap-2">⭐ PRONOSTICI SALVATI <span class="bg-purple-600 px-2 py-0.5 rounded text-xs">' + bettingMatches.length + '</span></div>';
        container.appendChild(sectionHeader);

        let sortedMatches = [...bettingMatches];
        if (sortMode === 'time') {
            sortedMatches.sort((a, b) => {
                if (!a.ora && !b.ora) return 0;
                if (!a.ora) return 1;
                if (!b.ora) return -1;
                return a.ora.localeCompare(b.ora);
            });
        } else {
            sortedMatches.sort((a, b) => (b.score || 0) - (a.score || 0));
        }

        sortedMatches.forEach((m, idx) => {
            try {
                const card = window.createUniversalCard(m, idx, m.strategyId || null);

                // Replace flag button with delete button
                const flagBtn = card.querySelector('.flag-btn, button[data-match-id]');
                if (flagBtn) {
                    const matchId = m.id || `${m.data}_${m.partita}`;
                    flagBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
                    flagBtn.className = 'text-red-400 hover:text-red-600 transition text-xl ml-2';
                    flagBtn.onclick = (e) => {
                        e.stopPropagation();
                        window.removeMatch(matchId);
                    };
                }

                container.appendChild(card);
            } catch (e) {
                console.error('[showMyMatches] Error creating card:', e, m);
            }
        });
    }
};

window.removeTradingFavorite = async function (pickId) {
    const idx = tradingFavorites.indexOf(pickId);
    if (idx >= 0) {
        tradingFavorites.splice(idx, 1);
        window.tradingFavorites = tradingFavorites; // Keep in sync
        window.updateMyMatchesCount();
        if (window.renderTradingFavoritesInStarTab) window.renderTradingFavoritesInStarTab();

        if (window.currentUser) {
            try {
                await setDoc(doc(db, "user_favorites", window.currentUser.uid), {
                    tradingPicks: tradingFavorites,
                    updatedAt: new Date().toISOString()
                }, { merge: true });
            } catch (e) {
                console.error("Error removing trading favorite:", e);
            }
        }
    }
};

window.removeMatch = async function (matchId) {
    const idx = window.selectedMatches.findIndex(m => {
        const id = m.id || `${m.data}_${m.partita}`;
        return id === matchId;
    });

    if (idx >= 0) {
        window.selectedMatches.splice(idx, 1);
        window.updateMyMatchesCount();

        // Re-render the list
        window.showMyMatches();

        // Save to Firebase
        if (window.currentUser) {
            try {
                await setDoc(doc(db, "users", window.currentUser.uid, "data", "selected_matches"), {
                    matches: window.selectedMatches,
                    updated: Date.now()
                });
            } catch (e) {
                console.error("Error removing match:", e);
            }
        }
    }
};

window.formatDateLong = function (str) {
    if (!str) return '';
    const d = new Date(str);
    return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
};

const STANDARD_STRATEGIES = ['all', 'italia', 'top_eu', 'cups', 'best_05_ht'];


// ==================== euGENIO CHATBOT LOGIC ====================
(function () {
    const chatWindow = document.getElementById('ai-chat-window');
    const toggleBtn = document.getElementById('toggle-chat-btn');
    const closeBtn = document.getElementById('close-chat-btn');
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    const messagesContainer = document.getElementById('chat-messages');

    if (!chatWindow || !toggleBtn) return;

    let isOpen = false;
    let chatHistory = [];
    let hasWelcomed = false;
    let eugenioPromptCache = null;

    window.loadEugenioPrompt = async function () {
        try {
            const promptDoc = await window.getDoc(window.doc(window.db, "system_prompts", "eugenio"));
            if (promptDoc.exists()) {
                eugenioPromptCache = promptDoc.data();
                console.log('[Eugenio] ✅ Prompt loaded from Firebase');
            }
        } catch (e) {
            console.error('[Eugenio] ❌ Error loading prompt:', e);
        }
    };

    function getUserName() {
        if (window.currentUserProfile && window.currentUserProfile.name) {
            return window.currentUserProfile.name;
        }
        if (window.currentUser && window.currentUser.email) {
            const name = window.currentUser.email.split('@')[0];
            return name.charAt(0).toUpperCase() + name.slice(1);
        }
        return "Amico";
    }

    function buildSystemPrompt() {
        const userName = getUserName();
        const strategies = window.strategiesData || {};
        const stats = window.globalStats || { total: 0, wins: 0, losses: 0, winrate: 0 };

        let strategiesText = Object.entries(strategies)
            .map(([id, s]) => `- **${s.name}**: ${s.totalMatches || 0} partite attive.`)
            .join('\n') || "Nessuna strategia caricata.";

        let prompt = `Sei **euGENIO 🧞‍♂️**, l'assistente AI di Tipster-AI.
Parla in prima persona singolare. Il tuo interlocutore è **${userName}**.

**STATISTICHE GLOBALI:**
- Totale: ${stats.total}
- Vinte: ${stats.wins}
- Winrate: ${stats.winrate}%

**STRATEGIE OGGI:**
${strategiesText}

**INFO EXTRA:**
${eugenioPromptCache?.additionalContext || ''}
${eugenioPromptCache?.tradingKnowledge || ''}

Regole:
1. Saluta SOLO nel primo messaggio.
2. Sii conciso e professionale.
3. Promuovi il gioco responsabile.`;

        return prompt;
    }

    function toggleChat() {
        isOpen = !isOpen;
        if (isOpen) {
            chatWindow.classList.remove('hidden');
            toggleBtn.classList.add('hidden');
            setTimeout(() => input.focus(), 100);

            if (!hasWelcomed) {
                const welcomeMsg = `Ciao ${getUserName()}! 👋 Sono euGENIO 🧞‍♂️. Come posso aiutarti oggi?`;
                appendMessage(welcomeMsg, 'ai');
                hasWelcomed = true;
            }
        } else {
            chatWindow.classList.add('hidden');
            toggleBtn.classList.remove('hidden');
        }
    }

    function appendMessage(text, sender) {
        const div = document.createElement('div');
        div.className = `flex ${sender === 'user' ? 'justify-end' : 'justify-start'}`;
        const bubble = document.createElement('div');
        bubble.className = sender === 'user'
            ? 'bg-purple-600 text-white rounded-2xl rounded-tr-none p-3 shadow-sm max-w-[85%]'
            : 'bg-white border border-gray-200 rounded-2xl rounded-tl-none p-3 shadow-sm max-w-[85%] text-gray-800';
        bubble.innerHTML = text;
        div.appendChild(bubble);
        messagesContainer.appendChild(div);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function showLoading() {
        const div = document.createElement('div');
        div.id = 'ai-loading';
        div.className = 'flex justify-start';
        div.innerHTML = `<div class="bg-white border border-gray-200 rounded-2xl rounded-tl-none p-3 shadow-sm">
            <div class="flex gap-1">
                <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0.2s"></div>
                <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0.4s"></div>
            </div>
        </div>`;
        messagesContainer.appendChild(div);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    toggleBtn.addEventListener('click', toggleChat);
    closeBtn.addEventListener('click', toggleChat);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;

        input.value = '';
        appendMessage(text, 'user');
        showLoading();

        try {
            if (chatHistory.length === 0) {
                if (!eugenioPromptCache) await window.loadEugenioPrompt();
                chatHistory.push({ role: "user", parts: [{ text: buildSystemPrompt() }] });
                chatHistory.push({ role: "model", parts: [{ text: "Certamente! Sono pronto ad aiutarti." }] });
            }

            chatHistory.push({ role: "user", parts: [{ text: text }] });

            const result = await window.chatWithGemini({
                contents: chatHistory,
                generationConfig: { temperature: 1, maxOutputTokens: 1024 }
            });

            const loading = document.getElementById('ai-loading');
            if (loading) loading.remove();

            const responseText = result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Scusa, non ho capito. 🧞‍♂️";
            chatHistory.push({ role: "model", parts: [{ text: responseText }] });

            // Simple markdown-ish to HTML
            const htmlText = responseText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
            appendMessage(htmlText, 'ai');

        } catch (err) {
            const loading = document.getElementById('ai-loading');
            if (loading) loading.remove();
            appendMessage("Ops! C'è stato un errore nel contattare euGENIO. 🧞‍♂️", 'ai');
        }
    });
})();

console.log('[App] Logic Initialized.');
