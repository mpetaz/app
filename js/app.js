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
let currentSortMode = 'time';

// ANTI-FLICKER CACHE: Remember last rendered data to avoid re-renders
let _lastRenderCache = {
    rankingHash: null,
    myMatchesHash: null,
    tradingHash: null
};

function getDataHash(data) {
    if (!data) return null;
    try {
        return JSON.stringify(data);
    } catch (e) {
        return Math.random().toString(); // Force render on error
    }
} // Forced to 'time' as per user request to avoid UI instability
let isRegisterMode = false;
let warningStats = null;
let tradingFavorites = []; // IDs of favorite trading picks
let currentTradingDate = new Date().toISOString().split('T')[0];
let tradingUnsubscribe = null; // For real-time updates
let strategiesUnsubscribe = null; // For real-time betting updates
let liveHubUnsubscribe = null; // For unified live scores hub
window.liveScoresHub = {}; // Global store for live updates
const HIGH_LIQUIDITY_LEAGUES = [
    "Serie A", "Serie B", "Premier League", "Championship", "League One",
    "La Liga", "Bundesliga", "Ligue 1", "Eredivisie", "Primeira Liga",
    "Super League", "Bundesliga (AUT)", "Pro League",
    "Champions League", "Europa League", "Conference League",
    "Coppa Italia", "FA Cup", "Copa del Rey"
];

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

// ==================== TRADING 2.0 UTILS ====================
function calculateGoalCookingPressure(stats, minute) {
    if (!stats || !minute || minute < 1) return 0;

    // Use pre-calculated value from backend if available for maximum consistency
    if (stats.pressureValue !== undefined) {
        return Math.round(parseFloat(stats.pressureValue) || 0);
    }

    const parsePair = (str) => {
        if (!str || typeof str !== 'string') return [0, 0];
        const parts = str.split('-').map(p => parseInt(p.trim()) || 0);
        return parts.length === 2 ? parts : [0, 0];
    };

    const [hDA, aDA] = parsePair(stats.dangerousAttacks);
    const [hSOG, aSOG] = parsePair(stats.shotsOnGoal);

    const daPerMin = (hDA + aDA) / minute;
    const sogPerMin = (hSOG + aSOG) / minute;

    // Heat formula: Weighted combination of dangerous attacks and shots on goal frequency
    // Normalized to 0-100 scale
    let pressure = (daPerMin * 45) + (sogPerMin * 180);

    // Bonus for high xG
    if (stats.xg) {
        const totalXG = parseFloat(stats.xg.home || 0) + parseFloat(stats.xg.away || 0);
        pressure += (totalXG / minute) * 100;
    }

    return Math.min(100, Math.round(pressure));
}

function getRankingColor(score) {
    if (!score && score !== 0) return 'gray-400';
    if (score >= 80) return 'emerald-500';
    if (score >= 65) return 'yellow-400';
    return 'red-500';
}

const isMatchStale = (m) => {
    // DISABILITATO SU RICHIESTA UTENTE PER RIPRISTINARE VISIBILITÀ TOTALE
    return false;
};

window.getLiveTradingAnalysis = async function (matchId) {
    const normalizedId = matchId.replace('trading_', '');
    let match = null;

    // 1. Search in Favorites
    if (window.selectedMatches) {
        match = window.selectedMatches.find(m => (m.id || `${m.data}_${m.partita}`) === matchId);
    }

    // 2. Search in Trading Cache
    if (!match && typeof lastTradingPicksCache !== 'undefined') {
        match = lastTradingPicksCache.find(p => window.getTradingPickId(p.partita) === matchId || p.id === matchId);
    }

    // 3. Search in all Strategies
    if (!match && window.strategiesData) {
        for (const strat of Object.values(window.strategiesData)) {
            if (strat.matches) {
                match = strat.matches.find(m => (m.id || `${m.data}_${m.partita}`) === matchId);
                if (match) break;
            }
        }
    }

    // 4. Search in Live Hub (NEW)
    if (!match && window.liveScoresHub) {
        match = Object.values(window.liveScoresHub).find(m => m.matchName === matchId || m.fixtureId === matchId);
    }

    if (!match) {
        console.warn(`[eugenio] Match ${matchId} not found in local memory.`);
        alert("Dati match non trovati in memoria. Provo comunque a generare un'analisi basica... 🧞‍♂️");
    }

    // Extract data - handle multiple formats (Trading picks vs Live Hub)
    // Live Hub format: match.elapsed, match.score, match.status
    // Trading format: match.liveData.elapsed, match.liveData.score
    const elapsed = (match?.elapsed || match?.liveData?.elapsed || match?.minute || '0').toString().replace("'", "");
    const score = match?.score || match?.liveData?.score || match?.risultato || "0-0";
    const status = match?.status || match?.liveData?.status || 'LIVE';
    const stats = match?.liveStats || match?.liveData?.stats || {};

    // Build stats string properly
    const da = stats.dangerousAttacks || "N/A";
    const sog = stats.shotsOnGoal || "N/A";
    const xg = stats.xg ? `${stats.xg.home?.toFixed(2) || stats.xg.home || 0} - ${stats.xg.away?.toFixed(2) || stats.xg.away || 0}` : "N/A";
    const pos = stats.possession || "N/A";

    // Build events summary if available
    const events = match?.events || [];
    let eventsText = '';
    if (events.length > 0) {
        const goals = events.filter(e => e.type?.toUpperCase().includes('GOAL'));
        const cards = events.filter(e => e.type?.toUpperCase().includes('CARD'));
        eventsText = `\n- Eventi: ${goals.length} gol, ${cards.length} cartellini`;
    }

    const prompt = `Analizza questo match LIVE per un'operazione professionale:
- Match: ${match?.partita || match?.matchName || 'Sconosciuto'}
- Minuto: ${elapsed}' (${status})
- Risultato: ${score}
- Valutazione Backend: ${match?.evaluation || 'LIVE'}
- Strategia/Tip: ${match?.strategy || match?.label || 'Monitoraggio'} ${match?.tip || ''}
- Statistiche: DA:${da}, SOG:${sog}, xG:${xg}, Possesso:${pos}${eventsText}

Fornisci un'analisi professionale in max 3-4 righe. Usa termini tecnici da Pro Trader. Concludi con un consiglio chiaro tra:
🚀 ENTRA (Se le condizioni sono ottimali)
✋ RESTA (Se sei già dentro, aspetta ancora)
💰 CASHOUT (Se è il momento di prendere i profitti o limitare i danni)
❌ NO ENTRY (Se il match è troppo stabile)`;

    // Open chat and send prompt
    const chatBtn = document.getElementById('toggle-chat-btn');
    if (chatBtn) chatBtn.click();

    // We need to wait for chat to open or just use the global function
    const input = document.getElementById('chat-input');
    const form = document.getElementById('chat-form');
    if (input && form) {
        input.value = prompt;
        form.dispatchEvent(new Event('submit'));
    }
};

window.resetPassword = async function () {
    const email = prompt('Inserisci la tua email per recuperare la password:');
    if (!email) return;

    try {
        await sendPasswordResetEmail(auth, email);
        alert('✅ Email inviata! Controlla la tua casella di posta per reimpostare la password.');
    } catch (error) {
        console.error('[Auth] Password reset error:', error);
        alert('⚠️ Errore: ' + (error.message || 'Email non valida'));
    }
};

// Helper: Rendering icone eventi live (Trading 2.0)
function renderEventIcon(type, detail) {
    const t = (type || "").toUpperCase();
    const d = (detail || "").toUpperCase();

    if (t.includes('GOAL')) return '⚽';
    if (t.includes('VAR') || d.includes('VAR')) return '🖥️';
    if (t.includes('SUBST') || t.includes('SOS') || d.includes('SUBSTITUTION')) return '🔄';
    if (t.includes('RED') || d.includes('RED CARD')) return '🟥';
    if (t.includes('YELLOW') || d.includes('YELLOW CARD')) return '🟨';
    if (t.includes('PENALTY')) return '🥅';
    if (t.includes('CORNER')) return '🚩';

    return '⏱️';
}

// ==================== LOCAL OUTCOME EVALUATOR (Fallback for non-API matches) ====================
function evaluateTipLocally(tip, risultato) {
    if (!tip || !risultato) return null;
    const parts = risultato.split('-').map(s => parseInt(s.trim()));
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;

    const gH = parts[0];
    const gA = parts[1];
    const total = gH + gA;
    const t = String(tip).toLowerCase().trim();

    // --- TRADING SPECIFICO: Pattern esatti valutati PRIMA dei generici ---
    // "Back Under X" = vinci se total < X (stesso di Lay Over)
    if (t.includes("back under 3.5") || t.includes("lay over 3.5")) return total < 4 ? 'Vinto' : 'Perso';
    if (t.includes("back under 2.5") || t.includes("lay over 2.5")) return total < 3 ? 'Vinto' : 'Perso';
    if (t.includes("back under 1.5") || t.includes("lay over 1.5")) return total < 2 ? 'Vinto' : 'Perso';

    // "Back Over X" = vinci se total >= X (stesso di Lay Under)
    if (t.includes("back over 2.5") || t.includes("lay under 2.5")) return total >= 3 ? 'Vinto' : 'Perso';
    if (t.includes("back over 3.5") || t.includes("lay under 3.5")) return total >= 4 ? 'Vinto' : 'Perso';

    // Lay the Draw
    if (t.includes("lay the draw") || t.includes("lay draw") || t.includes("laythedraw")) return gH !== gA ? 'Vinto' : 'Perso';

    // Over/Under logic (standard)
    if (t.includes("+0.5") || t.includes("over 0.5") || t.match(/\bo\s?0\.5/)) return total >= 1 ? 'Vinto' : 'Perso';
    if (t.includes("+1.5") || t.includes("over 1.5") || t.match(/\bo\s?1\.5/)) return total >= 2 ? 'Vinto' : 'Perso';
    if (t.includes("+2.5") || t.includes("over 2.5") || t.match(/\bo\s?2\.5/)) return total >= 3 ? 'Vinto' : 'Perso';
    if (t.includes("+3.5") || t.includes("over 3.5") || t.match(/\bo\s?3\.5/)) return total >= 4 ? 'Vinto' : 'Perso';
    if (t.includes("-0.5") || t.includes("under 0.5") || t.match(/\bu\s?0\.5/)) return total < 1 ? 'Vinto' : 'Perso';
    if (t.includes("-1.5") || t.includes("under 1.5") || t.match(/\bu\s?1\.5/)) return total < 2 ? 'Vinto' : 'Perso';
    if (t.includes("-2.5") || t.includes("under 2.5") || t.match(/\bu\s?2\.5/)) return total < 3 ? 'Vinto' : 'Perso';
    if (t.includes("-3.5") || t.includes("under 3.5") || t.match(/\bu\s?3\.5/)) return total < 4 ? 'Vinto' : 'Perso';

    // BTTS / No Goal
    if (t === "gg" || t.includes("btts") || t === "gol" || t === "goal") return (gH > 0 && gA > 0) ? 'Vinto' : 'Perso';
    if (t === "ng" || t === "no gol" || t === "no goal" || t.includes("no goal")) return (gH === 0 || gA === 0) ? 'Vinto' : 'Perso';

    // 1X2 / Double Chance
    const cleanT = t.replace(/[^a-z0-9]/g, "");
    if (cleanT === "1") return gH > gA ? 'Vinto' : 'Perso';
    if (cleanT === "2") return gA > gH ? 'Vinto' : 'Perso';
    if (cleanT === "x") return gH === gA ? 'Vinto' : 'Perso';
    if (cleanT === "1x" || cleanT === "x1") return gH >= gA ? 'Vinto' : 'Perso';
    if (cleanT === "x2" || cleanT === "2x") return gA >= gH ? 'Vinto' : 'Perso';
    if (cleanT === "12" || cleanT === "21") return gH !== gA ? 'Vinto' : 'Perso';

    return null;
}

// ==================== UNIVERSAL CARD RENDERER ====================
window.createUniversalCard = function (match, index, stratId, options = {}) {
    // 0. LIVE HUB SYNC: Check if we have real-time score/status for this match-tip
    const mName = match.partita || "";
    // CRITICAL: Use tradingInstruction.action if available (same as Backend)
    const mTip = match.tradingInstruction?.action || match.tip || "";
    // DEEP NORMALIZATION (Same as Backend)
    const mKey = mName.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(.)\1+/g, "$1");
    const tKey = mTip.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(.)\1+/g, "$1");
    const hubId = `${mKey}_${tKey}`;
    let liveHubData = window.liveScoresHub[hubId];

    // FUZZY FALLBACK: If exact ID not found, try to find by fuzzy matching name
    if (!liveHubData) {
        // Only try fuzzy if we have a substantial name (len > 3)
        if (mKey.length > 3) {
            const hubKeys = Object.keys(window.liveScoresHub);
            // 1. Try "contains" check first (faster)
            let bestKey = hubKeys.find(k => k.startsWith(mKey) || (k.includes(mKey) && k.includes(tKey)));

            // 2. If still nothing, use Levenshtein (if available from utils)
            if (!bestKey && typeof window.levenshteinDistance === 'function') {
                let bestDist = Infinity;
                hubKeys.forEach(k => {
                    // Check if tip matches first
                    if (!k.includes(tKey)) return;

                    const kMatchPart = k.split('_')[0]; // Extract match part
                    const dist = window.levenshteinDistance(mKey, kMatchPart);
                    // Match length for normalization
                    const maxLen = Math.max(mKey.length, kMatchPart.length);
                    // Only accept if similarity > 80% (dist < 20% of length)
                    if (dist < maxLen * 0.2 && dist < bestDist) {
                        bestDist = dist;
                        bestKey = k;
                    }
                });
            }

            if (bestKey) {
                liveHubData = window.liveScoresHub[bestKey];
                console.log(`[LiveHub] 🔦 Fuzzy Match Found: "${hubId}" -> "${bestKey}"`);
            }
        }
    }

    // DEBUG: Active to trace hubId lookups
    if (!liveHubData && index < 5) { // Limit logs
        console.log(`[CardDebug] ❌ Missed: "${hubId}" (Size: ${Object.keys(window.liveScoresHub).length})`);
    }

    if (liveHubData) {
        match = {
            ...match,
            risultato: liveHubData.score,
            status: liveHubData.status,
            minute: liveHubData.elapsed,
            // Priorità all'evaluation dell'Hub se il match è LIVE
            esito: liveHubData.evaluation,
            liveData: {
                ...match.liveData,
                score: liveHubData.score,
                elapsed: liveHubData.elapsed,
                status: liveHubData.status
            },
            liveStats: liveHubData.liveStats || match.liveStats,
            events: liveHubData.events || match.events
        };
    } else if (match.risultato && match.risultato.includes('-') && !match.esito) {
        // FALLBACK: Match has a result in local data but NOT in Hub AND NOT in permanent esito
        const localEsito = evaluateTipLocally(mTip, match.risultato);
        if (localEsito) {
            match = { ...match, esito: localEsito, status: 'FT', isNotMonitored: true };
            console.log(`[CardDebug] LOCAL FALLBACK: ${mName} | tip: ${mTip} | risultato: ${match.risultato} -> esito: ${localEsito}`);
        }
    }
    else if (!liveHubData && !match.risultato) {
        // IMPORTANTE: Solo le partite TERMINATE senza dati live sono "non monitorate"
        // Le partite FUTURE rimangono monitorate (mostrano "IN ATTESA")
        const isFinished = match.status && ['FT', 'AET', 'PEN', 'CANC', 'PST', 'ABD'].includes(match.status);
        if (isFinished) {
            match = { ...match, isNotMonitored: true };
        }
        // Altrimenti: partita futura o in corso, rimane monitorata (sarà "IN ATTESA" o mostrerà dati live)
    }

    // Detect Type
    const isMagia = (match.magicStats !== undefined) || (stratId && stratId.toLowerCase().includes('magia'));
    const isTrading = (['LAY_THE_DRAW', 'LAY_DRAW', 'BACK_OVER_25', 'HT_SNIPER', 'SECOND_HALF_SURGE', 'UNDER_35_SCALPING'].includes(match.strategy)) || options.isTrading;
    const matchId = match.id || `${match.data}_${match.partita}`;
    const isFlagged = !isTrading ? (window.selectedMatches || []).some(sm => sm.id === matchId) : tradingFavorites.includes(matchId);

    const rankingValue = Math.round(match.confidence || match.score || 0);
    const rankingColor = getRankingColor(rankingValue);
    const rankingBadgeHTML = rankingValue > 0 ? `<span class="bg-${rankingColor} text-black px-2 py-0.5 rounded-full text-[10px] font-black ml-2 shadow-sm border border-black/10 transition-transform hover:scale-110">${rankingValue}</span>` : '';

    // Style Configuration
    let headerClass = 'bg-gradient-to-r from-blue-900 via-indigo-900 to-blue-950';
    let headerIcon = '<i class="fa-solid fa-futbol"></i>';
    let headerTitle = 'Analisi Match';

    if (isMagia) {
        headerClass = 'bg-slate-100 border-b border-slate-200';
        headerIcon = '<i class="fa-solid fa-microchip text-indigo-500"></i>';
        headerTitle = 'Magia AI Scanner';
    } else if (isTrading) {
        switch (match.strategy) {
            case 'BACK_OVER_25':
                headerClass = 'bg-gradient-to-r from-purple-600 to-blue-600';
                headerIcon = '📊';
                headerTitle = 'Trading: BACK OVER 2.5';
                break;
            case 'LAY_THE_DRAW':
            case 'LAY_DRAW':
                headerClass = 'bg-gradient-to-r from-orange-500 to-red-500';
                headerIcon = '🎯';
                headerTitle = 'Trading: LAY THE DRAW';
                break;
            case 'HT_SNIPER':
                headerClass = 'bg-gradient-to-r from-red-600 to-rose-700 animate-pulse';
                headerIcon = '🎯';
                headerTitle = 'HT SNIPER';
                break;
            case 'SECOND_HALF_SURGE':
                headerClass = 'bg-gradient-to-r from-orange-600 to-amber-700';
                headerIcon = '🔥';
                headerTitle = '2ND HALF SURGE';
                break;
            case 'UNDER_35_SCALPING':
                headerClass = 'bg-gradient-to-r from-emerald-600 to-teal-700';
                headerIcon = '🛡️';
                headerTitle = 'Trading: UNDER SCALPING';
                break;
            default:
                headerClass = 'bg-gradient-to-r from-indigo-600 to-blue-700';
                headerIcon = '📈';
                headerTitle = 'Trading Sportivo';
        }
    }

    const card = document.createElement('div');
    // Color coding based on result (DARKER/VIVID colors) - ONLY for FINISHED matches
    let esitoClass = '';
    const isFinished = match.status === 'FT' || match.status === 'AET' || match.status === 'PEN';
    const finalEsito = (match.esito || "").toUpperCase();

    if (isFinished || liveHubData?.status === 'FT') {
        if (finalEsito === 'WIN' || finalEsito === 'VINTO') {
            esitoClass = 'bg-gradient-to-b from-green-200 to-green-300 border-green-400 ring-2 ring-green-300';
        } else if (finalEsito === 'LOSE' || finalEsito === 'PERSO') {
            esitoClass = 'bg-gradient-to-b from-red-200 to-red-300 border-red-400 ring-2 ring-red-300';
        } else if (finalEsito === 'CASH_OUT' || finalEsito === 'CASHOUT') {
            esitoClass = 'bg-gradient-to-b from-yellow-200 to-yellow-300 border-yellow-400 ring-2 ring-yellow-300';
        } else if (finalEsito === 'STOP_LOSS') {
            esitoClass = 'bg-gradient-to-b from-rose-300 to-rose-400 border-rose-500 ring-2 ring-rose-400';
        } else if (finalEsito === 'PUSH') {
            esitoClass = 'bg-gradient-to-b from-gray-200 to-gray-300 border-gray-400 ring-2 ring-gray-300';
        }
    }
    // DEBUG: Log esito and esitoClass for FT matches
    if (match.status === 'FT' || liveHubData?.status === 'FT') {
        console.log(`[EsitoDebug] ${mName} | evaluation: ${liveHubData?.evaluation} | esito: ${match.esito} | esitoClass: ${esitoClass ? 'SET' : 'EMPTY'}`);
    }

    card.className = `match-card rounded-3xl shadow-2xl fade-in mb-4 overflow-hidden relative transition-all duration-300 ${isMagia ? 'magia-scanner-card' : 'glass-card-premium'} ${esitoClass}`;
    if (isFlagged && isTrading) card.classList.add('ring-2', 'ring-emerald-500');

    // --- Footer ---
    // Moved Flag Button to Header

    // Header Generation with Star
    const flagBtnHTML = isTrading
        ? `<button data-match-id="${matchId}" class="text-white/70 hover:text-white transition text-xl bg-white/10 w-8 h-8 rounded-full flex items-center justify-center backdrop-blur-sm" onclick="toggleTradingFavorite('${matchId}'); event.stopPropagation();">
             <i class="${isFlagged ? 'fa-solid text-yellow-300' : 'fa-regular'} fa-star"></i>
           </button>`
        : `<button data-match-id="${matchId}" class="flag-btn ${isFlagged ? 'flagged text-yellow-300' : 'text-white/60'} hover:text-yellow-300 transition text-xl ml-2" onclick="toggleFlag('${matchId}'); event.stopPropagation();">
             ${isFlagged ? '<i class="fa-solid fa-star drop-shadow-md"></i>' : '<i class="fa-regular fa-star"></i>'}
           </button>`;

    let headerHTML = '';
    const elapsed = match.liveData?.elapsed || match.liveData?.minute || 0;
    const isLive = elapsed > 0;
    const isRealTimeMatch = isTrading || isMagia || (match.lega && HIGH_LIQUIDITY_LEAGUES.includes(match.lega));

    if (isMagia) {
        headerHTML = `
            <div class="p-3 flex justify-between items-center text-slate-800 relative border-b border-slate-200 bg-white">
                <div class="flex items-center gap-2">
                    <div class="w-6 h-6 rounded bg-indigo-50 flex items-center justify-center border border-indigo-100">
                        <i class="fa-solid fa-microchip text-indigo-500 text-[10px]"></i>
                    </div>
                    <span class="font-black text-[10px] tracking-widest uppercase text-slate-500">MAGIA AI SCANNER</span>
                    <span class="bg-indigo-500 text-white px-1.5 py-0.5 rounded text-[10px] font-black shadow-sm">${rankingValue}</span>
                </div>
                <div class="flex items-center gap-2">
                    ${match.ora ? `<div class="text-slate-400 text-[10px] font-bold flex items-center gap-1"><i class="fa-regular fa-clock"></i> ${match.ora}</div>` : ''}
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
                    ${rankingBadgeHTML}
                </div>
                <div class="flex items-center gap-2">
                    ${match.ora ? `<span class="text-xs bg-white/20 px-2 py-0.5 rounded font-bold">⏰ ${match.ora}</span>` : ''}
                    ${flagBtnHTML}
                </div>
                ${isLive && isTrading ? `
                <div class="absolute bottom-0 left-0 h-1 bg-white/10 w-full overflow-hidden">
                    <div class="h-full bg-yellow-400 goal-cooking-bar" style="width: ${calculateGoalCookingPressure(match.liveStats, elapsed)}%"></div>
                </div>` : ''}
            </div>
        `;
    }

    // --- Teams & Score ---
    const currentScore = match.liveData?.score || (match.liveData ? `${match.liveData.homeScore || 0} - ${match.liveData.awayScore || 0}` : null);

    // Status Badge (Minute / HT / FT) - Show minute when LIVE
    let statusBadge = '';
    if (match.status === 'FT' || match.status === 'AET' || match.status === 'PEN') {
        statusBadge = '<span class="bg-gray-800 text-white px-1.5 py-0.5 rounded text-[10px] font-bold">FT</span>';
    } else if (match.status === 'HT') {
        statusBadge = '<span class="bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded text-[10px] font-bold">HT</span>';
    } else if (match.minute || match.liveData?.elapsed) {
        const minute = match.minute || match.liveData.elapsed;
        statusBadge = `<span class="bg-blue-500 text-white px-1.5 py-0.5 rounded text-[10px] font-bold">${minute}'</span>`;
    } else if (match.risultato?.includes('HT')) {
        statusBadge = '<span class="bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded text-[10px] font-bold">HT</span>';
    } else if (match.risultato?.includes('FT')) {
        statusBadge = '<span class="bg-gray-800 text-white px-1.5 py-0.5 rounded text-[10px] font-bold">FT</span>';
    }

    const scoreDisplay = (isTrading && options.detailedTrading && currentScore)
        ? `<div class="mt-1 text-2xl font-black text-gray-900 tracking-widest">${currentScore}</div>`
        : (match.risultato ? `<div class="mt-1 flex flex-col items-center gap-1">
                                <div class="text-xl font-black text-gray-900">${match.risultato.replace('HT', '').replace('FT', '').trim()}</div>
                                ${statusBadge}
                             </div>` : (match.isNotMonitored ? `
                                <div class="mt-2 flex flex-col items-center">
                                    <span class="bg-red-100 text-red-600 border border-red-200 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-tighter">
                                        <i class="fa-solid fa-eye-slash mr-1"></i> NON MONITORATA
                                    </span>
                                </div>
                             ` : ''));

    const teamsHTML = `
        <div class="p-4 text-center">
            <div class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">${match.lega || 'Unknown League'}</div>
            <div class="text-xl font-black text-slate-800 leading-tight mb-1">${match.partita}</div>
            ${scoreDisplay}
            ${!isLive && match.isNotMonitored ? `
                <div class="mt-3 inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-red-500/10 border border-red-500/20">
                    <span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>
                    <span class="text-[9px] font-black text-red-400 uppercase tracking-widest">NON MONITORATA</span>
                </div>
            ` : ''}
        </div>
    `;

    // --- Primary Signal ---
    let primarySignalHTML = '';
    const ms = match.magicStats || {};

    if (isMagia) {
        primarySignalHTML = `
            <div class="px-4 mb-4">
                <!-- Main Prediction Box -->
                <div class="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 text-center relative overflow-hidden">
                    <span class="text-[9px] font-black text-indigo-400 uppercase tracking-widest mb-1 block">PREVISIONE IA</span>
                    <div class="text-2xl font-black text-slate-800 mb-1">${ms.tipMagiaAI || match.tip || '-'}</div>
                    ${ms.oddMagiaAI ? `<div class="inline-block bg-indigo-500 text-white text-[10px] font-black px-2 py-0.5 rounded-full">@ ${ms.oddMagiaAI}</div>` : ''}
                </div>

                <!-- Probability AI (Triple Bar) -->
                <div class="mt-4">
                    <div class="flex justify-between items-end mb-1">
                         <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest">PROBABILITÀ AI</span>
                    </div>
                    <div class="prob-bar-container mb-2">
                        <div class="prob-segment-home" style="width: ${ms.winHomeProb || 0}%"></div>
                        <div class="prob-segment-draw" style="width: ${ms.drawProb || 0}%"></div>
                        <div class="prob-segment-away" style="width: ${ms.winAwayProb || 0}%"></div>
                    </div>
                    <div class="flex justify-between text-[9px] font-bold text-slate-400">
                        <span>1 (${Math.round(ms.winHomeProb || 0)}%)</span>
                        <span>X (${Math.round(ms.drawProb || 0)}%)</span>
                        <span>2 (${Math.round(ms.winAwayProb || 0)}%)</span>
                    </div>
                </div>

                <!-- Strong Signals Checkboxes -->
                <div class="mt-4">
                    <div class="text-[8px] font-black text-center text-slate-400 uppercase tracking-widest mb-2">SEGNALI FORTI</div>
                    <div class="grid grid-cols-3 gap-2">
                        ${(ms.topSignals || []).slice(0, 3).map(sig => `
                            <div class="bg-slate-50 border border-slate-100 rounded-xl p-2 text-center">
                                <div class="text-[8px] text-indigo-500 font-bold uppercase mb-0.5">${sig.label}</div>
                                <div class="text-xs font-black text-slate-800">${sig.prob}%</div>
                            </div>
                        `).join('')}
                    </div>
                </div>

                <!-- HT Snipper Mini Row (Mockup Style) -->
                ${ms.over15Prob > 60 ? `
                <div class="mt-4 bg-purple-900/20 border border-purple-500/10 rounded-2xl p-3 flex justify-between items-center">
                    <div class="flex items-center gap-2">
                        <div class="w-2 h-2 rounded-full bg-purple-400 animate-pulse"></div>
                        <span class="text-[10px] font-bold text-purple-300">Gol nel Primo Tempo (0.5 HT)</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-[10px] font-black text-white bg-purple-500/30 px-2 py-0.5 rounded-lg">${Math.round(ms.over15Prob * 0.7)}%</span>
                        <span class="text-[10px] font-bold text-purple-400 opacity-50">@1.54</span>
                    </div>
                </div>` : ''}
            </div>
        `;
    } else {
        primarySignalHTML = `
            <div class="px-4 mb-3">
                <div class="bg-slate-50 border border-slate-100 rounded-xl p-3 flex flex-col items-center">
                     <span class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-0.5">CONSIGLIO</span>
                     <div class="text-2xl font-black text-slate-800">${match.tip}</div>
                     ${match.quota ? `<div class="mt-1 bg-indigo-500 text-white text-[9px] font-black px-2 py-0.5 rounded-full">@ ${match.quota}</div>` : ''}
                </div>
            </div>
        `;
    }

    // --- Insights / detailedTrading ---
    let insightsHTML = '';

    // TRADING: Live Stats & Sniper Trigger
    if (isTrading && options.detailedTrading && match.liveStats) {
        const pos = typeof match.liveStats.possession === 'object'
            ? `${match.liveStats.possession.home}% - ${match.liveStats.possession.away}%`
            : (match.liveStats.possession || '0% - 0%');

        const pressure = calculateGoalCookingPressure(match.liveStats, match.liveData?.elapsed || match.liveData?.minute || 0);
        // Sniper trigger moved to background/Telegram, simplified UI here
        const isSniperTrigger = (match.strategy === 'HT_SNIPER' && (match.liveData?.elapsed >= 15 && match.liveData?.elapsed <= 25) && (match.liveData?.score === '0-0'));

        insightsHTML += `
            <div class="px-4 mb-2">
                ${isSniperTrigger ? `
                <div class="bg-indigo-50 border border-indigo-100 text-indigo-700 text-[9px] font-bold p-1.5 rounded-lg mb-2 flex items-center justify-between">
                    <span>🎯 FINESTRA SNIPER ATTIVA</span>
                    <i class="fa-solid fa-clock"></i>
                </div>` : ''}

                <div class="bg-slate-50 rounded-xl p-2.5 border border-slate-100 mb-2">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-[8px] font-bold text-slate-400 uppercase">Goal Cooking Indicator</span>
                        <span class="text-[9px] font-black ${pressure > 70 ? 'text-orange-500' : 'text-blue-500'}">${pressure}%</span>
                    </div>
                    <div class="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-blue-400 via-yellow-400 to-red-400" style="width: ${pressure}%"></div>
                    </div>
                </div>

                <div class="grid grid-cols-3 gap-2 text-center text-xs bg-gray-50 p-2 rounded-lg border border-gray-100">
                     <div>
                        <div class="text-[10px] text-gray-400 font-bold uppercase">Possesso</div>
                        <div class="font-black text-gray-800 text-xs">${pos}</div>
                     </div>
                     <div>
                        <div class="text-[10px] text-gray-400 font-bold uppercase">Tiri (Porta)</div>
                        <div class="font-black text-gray-800 text-xs">${match.liveStats.shotsOnGoal || (match.liveStats.shots ? `${match.liveStats.shots.home}-${match.liveStats.shots.away}` : '0-0')}</div>
                     </div>
                     <div>
                        <div class="text-[10px] text-gray-400 font-bold uppercase">XG</div>
                        <div class="font-black text-gray-800 text-xs">${match.liveStats.xg?.home || 0} - ${match.liveStats.xg?.away || 0}</div>
                     </div>
                </div>
                
                <!-- Live Insight Button -->
                <button onclick="window.getLiveTradingAnalysis('${matchId}')" class="w-full mt-2 bg-indigo-100 text-indigo-700 py-2 rounded-lg text-xs font-bold hover:bg-indigo-200 transition flex items-center justify-center gap-2">
                    <i class="fa-solid fa-brain"></i> euGENIO LIVE INSIGHT
                </button>
            </div>
        `;
    }

    // TRADING: Events Timeline
    if (options.detailedTrading && match.events && match.events.length > 0) {
        // Detailed timeline for favorites/trading
        const isStarTab = document.getElementById('btn-hub-fav')?.classList.contains('active');

        insightsHTML += `
            <div class="px-4 mb-3">
                 <div class="text-[9px] font-bold text-gray-300 uppercase tracking-widest mb-1">Live Hub Events</div>
                     <div class="flex flex-col gap-1 max-h-32 overflow-y-auto scrollbar-hide">
                        ${match.events.slice().reverse().map(ev => {
            const time = ev.time?.elapsed || ev.time || ev.minute || 0;
            const icon = renderEventIcon(ev.type, ev.detail);
            const typeText = ev.type || "";
            const detailText = ev.detail || ev.player?.name || "";

            // Avoid redundant text like "Goal - Normal Goal"
            const displayInfo = (typeText.toLowerCase() === detailText.toLowerCase() || !detailText)
                ? typeText
                : `${typeText}: ${detailText}`;

            return `
                            <div class="flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-lg p-1.5 text-[10px] shadow-sm">
                                <span class="font-black text-gray-400 w-6">${time}'</span>
                                <span class="text-sm">${icon}</span>
                                <span class="font-bold text-gray-700 truncate">${displayInfo}</span>
                                ${ev.type === 'subst' ? `<span class="text-[9px] text-gray-400 italic">(${ev.assist?.name || ''})</span>` : ''}
                            </div>`;
        }).join('')}
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

    // euGENIO Insight
    const why = match.why || match.spiegazione || match.insight || "";
    if (why) {
        insightsHTML += `
            <div class="px-4 mb-3">
                <div class="eugenio-why-box border border-indigo-100 shadow-sm relative overflow-hidden bg-indigo-50/30">
                    <div class="flex items-center gap-1.5 mb-1">
                        <i class="fa-solid fa-brain text-[10px] text-indigo-400"></i>
                        <span class="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Il Perché di euGENIO</span>
                    </div>
                    ${why}
                </div>
            </div>
        `;
    }

    // Warnings (Standard Only)
    // isFinished is already defined at top of function
    if (!isMagia && !isTrading && warningStats && STANDARD_STRATEGIES.includes(stratId)) {
        const volatile = warningStats.volatileLeagues?.find(l => l.lega === match.lega);
        if (volatile && !isFinished) {
            insightsHTML += `
                <div class="mx-4 mb-3 bg-red-50 border border-red-200 rounded-lg p-2 flex items-center gap-2">
                    <i class="fa-solid fa-triangle-exclamation text-red-500 text-xs"></i>
                    <div class="text-[10px] text-red-700 font-bold">Lega volatile (${volatile.volatility}% vol)</div>
                </div>
             `;
        }
    }

    // 05 HT Logic
    const htHTML = match.info_ht && match.info_ht.trim() !== '' ? (() => {
        const htMatch = match.info_ht.match(/(\d+)%.*?@?([\d.,]+)/);
        const htProb = htMatch ? htMatch[1] : '';
        const htQuota = htMatch ? htMatch[2] : '';

        return `
            <div class="px-4 mb-3">
                <div class="bg-purple-50 border border-purple-100 rounded-xl p-3">
                    <div class="flex justify-between items-center">
                        <div class="flex items-center gap-2">
                            <i class="fa-solid fa-fire text-purple-400 text-xs"></i>
                            <span class="text-[10px] font-black text-purple-400 uppercase tracking-widest">Gol 0.5 HT</span>
                        </div>
                        <div class="flex items-center gap-2">
                            ${htProb ? `<span class="bg-purple-100 text-purple-600 text-[10px] font-black px-1.5 py-0.5 rounded-lg border border-purple-200">${htProb}%</span>` : ''}
                            ${htQuota ? `<span class="bg-white text-purple-600 text-[10px] font-black px-1.5 py-0.5 rounded-lg border border-purple-100 shadow-sm">@ ${htQuota}</span>` : ''}
                        </div>
                    </div>
                </div>
            </div>`;
    })() : '';

    insightsHTML += htHTML;

    // --- Rationale (If second source exists) ---
    const alternativeRationale = match.logicRationale || match.logic_rationale || match.reasoning || "";
    if (alternativeRationale && !why) {
        insightsHTML += `
            <div class="px-4 mb-3">
                <div class="eugenio-why-box border border-indigo-100 shadow-sm relative overflow-hidden bg-indigo-50/30">
                    <div class="flex items-center gap-1.5 mb-1">
                        <i class="fa-solid fa-brain text-[10px] text-indigo-400"></i>
                        <span class="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Il Perché di euGENIO</span>
                    </div>
                    ${alternativeRationale}
                </div>
            </div>
        `;
    }

    // --- Footer with Monitoring Badge ---
    let notMonitoredBadge = '';
    if (match.isNotMonitored) {
        const now = new Date();
        const matchDateTime = new Date(`${match.data || now.toISOString().split('T')[0]}T${match.ora || '00:00'}:00`);
        const isFuture = matchDateTime > now;
        notMonitoredBadge = isFuture
            ? '<span class="text-[9px] font-bold text-blue-400 uppercase tracking-widest bg-blue-500/10 px-2 py-0.5 rounded-full flex items-center gap-1"><i class="fa-regular fa-clock"></i> In Attesa</span>'
            : '<span class="text-[9px] font-bold text-orange-500 uppercase tracking-widest bg-orange-500/10 px-2 py-0.5 rounded-full flex items-center gap-1"><i class="fa-solid fa-satellite-dish"></i> Connessione...</span>';
    }

    const footerHTML = `
        <div class="bg-slate-50 p-2 border-t border-slate-100 flex justify-between items-center px-4">
              <div class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">TIPSTER AI</div>
              <div class="flex items-center gap-2">
                ${match.status === 'FT' ? '<span class="text-[9px] font-black text-green-600">● MATCH CONCLUSO</span>' : (notMonitoredBadge || '<span class="text-[9px] font-black text-indigo-500 animate-pulse">● MONITORAGGIO ATTIVO</span>')}
              </div>
        </div>
    `;

    card.innerHTML = headerHTML + teamsHTML + primarySignalHTML + insightsHTML + footerHTML;
    return card;
};

// ==================== TRADING LOGIC ====================
let tradingFilterState = 'all'; // all, live, favs
let lastTradingPicksCache = [];

window.initTradingPage = function () {
    // Filter Listeners
    const filters = {
        'filter-trading-all': 'all',
        'filter-trading-live': 'live',
        'filter-trading-favs': 'favs'
    };

    Object.entries(filters).forEach(([id, state]) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.onclick = () => {
            tradingFilterState = state;
            // UI Update
            Object.keys(filters).forEach(k => {
                const b = document.getElementById(k);
                b.className = (k === id)
                    ? 'flex-1 py-2 px-3 rounded-lg font-bold text-xs transition-all bg-gray-800 text-white shadow-lg'
                    : 'flex-1 py-2 px-3 rounded-lg font-bold text-xs transition-all bg-transparent text-gray-500 hover:bg-gray-800 flex items-center justify-center gap-1';
            });
            window.renderTradingCards(lastTradingPicksCache);
        };
    });

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

/**
 * TAB: I CONSIGLI
 * Generates Smart Parlays (Multiple) based on the day's top picks.
 */
window.loadTipsPage = function () {
    const parlays = {
        x2: { id: 'parlay-x2', qty: 2, matches: [] },
        x3: { id: 'parlay-x3', qty: 3, matches: [] },
        x4: { id: 'parlay-x4', qty: 4, matches: [] }
    };

    // 1. Gather ALL available matches for today from strategiesData
    let allPicks = [];
    Object.entries(window.strategiesData).forEach(([stratId, strat]) => {
        if (strat.matches) {
            strat.matches.forEach(m => {
                if (m.data === window.currentAppDate) {
                    allPicks.push({ ...m, stratId });
                }
            });
        }
    });

    // 2. Sort by confidence/score (AI Quality)
    allPicks.sort((a, b) => (b.score || 0) - (a.score || 0));

    // 3. Remove Duplicates (same partita)
    const seen = new Set();
    const uniquePicks = allPicks.filter(m => {
        if (seen.has(m.partita)) return false;
        seen.add(m.partita);
        return true;
    });

    // 4. Fill Parlays
    if (uniquePicks.length < 2) {
        if (document.getElementById('parlays-container')) document.getElementById('parlays-container').classList.add('hidden');
        if (document.getElementById('no-tips-msg')) document.getElementById('no-tips-msg').classList.remove('hidden');
        return;
    }

    if (document.getElementById('parlays-container')) document.getElementById('parlays-container').classList.remove('hidden');
    if (document.getElementById('no-tips-msg')) document.getElementById('no-tips-msg').classList.add('hidden');

    Object.keys(parlays).forEach(key => {
        const config = parlays[key];
        const container = document.querySelector(`#${config.id} .parlay-matches`);
        const oddsLabel = document.getElementById(`${config.id}-odds`);

        if (!container) return;

        const selected = uniquePicks.slice(0, config.qty);
        let totalOdds = 1.0;

        container.innerHTML = '';
        selected.forEach(m => {
            const quotaStr = String(m.quota || '1.10').replace(',', '.');
            const quota = parseFloat(quotaStr);
            totalOdds *= quota;

            const item = document.createElement('div');
            item.className = 'flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/5';
            item.innerHTML = `
        <div class="flex-1" >
                    <div class="text-[10px] text-gray-400 uppercase font-black">${m.lega || ''}</div>
                    <div class="text-xs font-bold text-white">${m.partita}</div>
                    <div class="text-[10px] text-orange-300 font-bold">${m.tip}</div>
                </div>
        <div class="text-xs font-black text-indigo-300 ml-4">@${m.quota || '1.10'}</div>
    `;
            container.appendChild(item);
        });

        if (oddsLabel) oddsLabel.textContent = `Totale: @${totalOdds.toFixed(2)} `;
    });
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
            window.renderTradingCards([], {});
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

                // Try multiple ID formats for matching
                let sig = signalsMap[pickId] || signalsMap[`trading_${pickId} `] || signalsMap[pickId.replace('trading_', '')];

                if (!sig) {
                    // Try to find by partial match on name (normalized)
                    const cleanPickName = pick.partita.toLowerCase().replace(/[^a-z]/g, "");
                    for (const sid in signalsMap) {
                        if (sid.includes(cleanPickName)) {
                            sig = signalsMap[sid];
                            break;
                        }
                    }
                }

                if (sig) {
                    // Normalize sig data to ensure consistent structure if needed, 
                    // or just merge as is since createUniversalCard is now more robust.
                    return { ...pick, ...sig, id: pickId };
                }
                return { ...pick, id: pickId };
            });

            window._prevScrollY = window.scrollY;
            window.renderTradingCards(mergedPicks);

            // Restore scroll after rendering
            if (window._prevScrollY) {
                window.scrollTo(0, window._prevScrollY);
                delete window._prevScrollY;
            }

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

window.renderTradingCards = function (picks) {
    lastTradingPicksCache = picks;
    const container = document.getElementById('trading-cards-container');
    if (!container) return;

    // ANTI-FLICKER: Skip render if data hasn't changed
    const dataHash = getDataHash(picks);
    if (_lastRenderCache.tradingHash === dataHash) {
        console.log('[Trading Render] ⏭️ SKIPPED (data unchanged)');
        return;
    }
    _lastRenderCache.tradingHash = dataHash;

    if (picks.length === 0) {
        document.getElementById('trading-empty').classList.remove('hidden');
        return;
    }

    // 1. Filter
    let filtered = picks.filter(p => !isMatchStale(p));
    if (tradingFilterState === 'live') {
        filtered = filtered.filter(p => (p.liveData?.elapsed || p.liveData?.minute || 0) > 0);
    } else if (tradingFilterState === 'favs') {
        filtered = filtered.filter(p => (window.tradingFavorites || []).includes(window.getTradingPickId(p.partita)));
    }

    if (filtered.length === 0) {
        if (picks.length > 0) {
            container.replaceChildren();
            document.getElementById('trading-empty').classList.remove('hidden');
        }
        return;
    }

    // 2. Smart Sorting
    const getPriority = (p) => {
        const isFav = (window.tradingFavorites || []).includes(window.getTradingPickId(p.partita));
        const isLive = (p.liveData?.elapsed || p.liveData?.minute || 0) > 0;
        if (isFav && isLive) return 1;
        if (isLive) return 2;
        if (isFav) return 3;
        return 4;
    };

    filtered.sort((a, b) => {
        const pA = getPriority(a);
        const pB = getPriority(b);
        if (pA !== pB) return pA - pB;
        return (a.ora || '').localeCompare(b.ora || '');
    });

    document.getElementById('trading-empty').classList.add('hidden');

    const cards = filtered.map(pick => {
        const isFav = (window.tradingFavorites || []).includes(window.getTradingPickId(pick.partita));
        const isLive = (pick.liveData?.elapsed || pick.liveData?.minute || 0) > 0;

        const card = window.createUniversalCard(pick, 0, null, { isTrading: true, detailedTrading: true });

        // Final Polish
        if (isFav && isLive) {
            card.classList.add('ring-2', 'ring-emerald-400', 'shadow-lg', 'shadow-emerald-500/20');
        } else if (isLive) {
            card.classList.add('border-l-4', 'border-l-red-500');
        }
        return card;
    });

    container.replaceChildren(...cards);
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

    // Sync state
    window.tradingFavorites = tradingFavorites;

    // Trigger re-render to update Smart Sorting & Count
    if (window.renderTradingCards && lastTradingPicksCache.length > 0) {
        window.renderTradingCards(lastTradingPicksCache);
    }

    if (window.renderTradingFavoritesInStarTab) {
        window.renderTradingFavoritesInStarTab();
    }

    try {
        await setDoc(doc(db, "user_favorites", window.currentUser.uid), {
            tradingPicks: tradingFavorites,
            updatedAt: new Date().toISOString()
        }, { merge: true });
    } catch (e) { console.error("Error saving favorites:", e); }
};

window.renderTradingFavoritesInStarTab = function () {
    const picks = lastTradingPicksCache || [];
    const activeFavs = picks.filter(p => (window.tradingFavorites || []).includes(window.getTradingPickId(p.partita)));
    window.activeTradingFavoritesCount = activeFavs.length;
    window.updateMyMatchesCount();

    // Clean up container just in case
    const container = document.getElementById('trading-favorites-container');
    if (!container) return;

    if (activeFavs.length === 0) {
        container.replaceChildren();
        return;
    }

    const cards = activeFavs.map(pick => window.createUniversalCard(pick, 0, null, { isTrading: true, isFavorite: true, detailedTrading: true }));
    container.replaceChildren(...cards);
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
        initLiveHubListener(); // Start global live scores sync

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
document.getElementById('logout-btn')?.addEventListener('click', () => signOut(auth));

// Auth Form Listeners
document.getElementById('toggle-login')?.addEventListener('click', () => {
    isRegisterMode = false;
    document.getElementById('auth-title').textContent = 'Accedi a TipsterAI';
    document.getElementById('auth-submit-btn').textContent = 'Accedi';
    document.getElementById('name-field').classList.add('hidden');
    document.getElementById('toggle-login').classList.add('bg-purple-600', 'text-white');
    document.getElementById('toggle-login').classList.remove('text-gray-600');
    document.getElementById('toggle-register').classList.remove('bg-purple-600', 'text-white');
    document.getElementById('toggle-register').classList.add('text-gray-600');
    document.getElementById('forgot-password-link').classList.remove('hidden');
});

document.getElementById('toggle-register')?.addEventListener('click', () => {
    isRegisterMode = true;
    document.getElementById('auth-title').textContent = 'Registrati a TipsterAI';
    document.getElementById('auth-submit-btn').textContent = 'Registrati';
    document.getElementById('name-field').classList.remove('hidden');
    document.getElementById('toggle-register').classList.add('bg-purple-600', 'text-white');
    document.getElementById('toggle-register').classList.remove('text-gray-600');
    document.getElementById('toggle-login').classList.remove('bg-purple-600', 'text-white');
    document.getElementById('toggle-login').classList.add('text-gray-600');
    document.getElementById('forgot-password-link').classList.add('hidden');
});

document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailValue = document.getElementById('email').value;
    const passwordValue = document.getElementById('password').value;
    const errorDiv = document.getElementById('auth-error');
    errorDiv.classList.add('hidden');

    try {
        if (isRegisterMode) {
            const userName = document.getElementById('user-name').value.trim();
            if (!userName) throw new Error('Nickname obbligatorio');

            const userCredential = await createUserWithEmailAndPassword(auth, emailValue, passwordValue);
            await setDoc(doc(db, "users", userCredential.user.uid), {
                name: userName,
                email: emailValue,
                createdAt: new Date().toISOString(),
                subscription: "free",
                telegramLinked: false
            });
        } else {
            await signInWithEmailAndPassword(auth, emailValue, passwordValue);
        }
    } catch (err) {
        errorDiv.textContent = err.message;
        errorDiv.classList.remove('hidden');
    }
});

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
    console.log('[Profile] Loading for UID:', uid);
    try {
        const docSnap = await getDoc(doc(db, "users", uid));
        if (docSnap.exists()) {
            window.currentUserProfile = docSnap.data();
            const nick = window.currentUserProfile.name || 'Utente';
            const elHeader = document.getElementById('user-nickname-header');
            if (elHeader) elHeader.textContent = `Ciao, ${nick} ! 👋`;

            // Auto-populate account page if it's currently visible
            if (typeof window.populateAccountPage === 'function') {
                window.populateAccountPage();
            }
        }
    } catch (e) {
        console.error("Profile Error", e);
    }
}

async function loadData(dateToLoad = null) {
    const targetDate = dateToLoad || new Date().toISOString().split('T')[0];
    window.currentAppDate = targetDate; // Set global date for filtering

    if (strategiesUnsubscribe) {
        strategiesUnsubscribe();
        strategiesUnsubscribe = null;
    }

    try {
        // Use onSnapshot for real-time betting strategies update
        strategiesUnsubscribe = onSnapshot(doc(db, "daily_strategies", targetDate), (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
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

                // RE-RENDER PAGES IF ACTIVE
                if (currentStrategyId && document.getElementById('page-ranking')?.classList.contains('active')) {
                    window._prevScrollY = window.scrollY;
                    window.showRanking(currentStrategyId, window.strategiesData[currentStrategyId], currentSortMode);
                    if (window._prevScrollY) {
                        window.scrollTo(0, window._prevScrollY);
                        delete window._prevScrollY;
                    }
                }
                if (document.getElementById('page-my-matches')?.classList.contains('active')) {
                    window._prevScrollY = window.scrollY;
                    window.showMyMatches(currentSortMode);
                    if (window._prevScrollY) {
                        window.scrollTo(0, window._prevScrollY);
                        delete window._prevScrollY;
                    }
                }
            } else {
                console.warn("No data for date:", targetDate);

                // Auto-fallback to yesterday if today has no data
                const todayStr = new Date().toISOString().split('T')[0];
                if (targetDate === todayStr && !dateToLoad) {
                    const yesterdayDate = new Date();
                    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
                    const yesterday = yesterdayDate.toISOString().split('T')[0];
                    console.log(`[LoadData] No data for today, falling back to yesterday: ${yesterday} `);
                    // Recursively call loadData with yesterday
                    loadData(yesterday);
                } else {
                    // Try generic fallback only if it's not a date-specific load
                    getDoc(doc(db, "system", "strategy_results")).then(fallbackSnap => {
                        if (fallbackSnap.exists()) {
                            window.strategiesData = fallbackSnap.data();
                            renderStrategies();
                        }
                    });
                }
            }
        });

        // Load Favorites (One-time or on change could be better, but staying consistent)
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

        // START LIVE HUB LISTENER
        initLiveHubListener();

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

function initLiveHubListener() {
    if (liveHubUnsubscribe) liveHubUnsubscribe();

    console.log('[LiveHub] Initializing real-time listener...');
    liveHubUnsubscribe = onSnapshot(collection(db, "live_scores_hub"), (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            const data = change.doc.data();
            const id = change.doc.id;

            if (change.type === "removed") {
                delete window.liveScoresHub[id];
            } else {
                window.liveScoresHub[id] = data;
            }
        });

        console.log(`[LiveHub] Sync complete.${Object.keys(window.liveScoresHub).length} active updates.`);

        // Trigger dynamic re-renders of active pages
        if (document.getElementById('page-ranking')?.classList.contains('active')) {
            window.showRanking(currentStrategyId, window.strategiesData[currentStrategyId], currentSortMode);
        }
        if (document.getElementById('page-my-matches')?.classList.contains('active')) {
            window.showMyMatches();
        }
        // Also re-render Trading and Star pages
        if (document.getElementById('page-trading')?.classList.contains('active')) {
            if (window.currentTradingDate) window.loadTradingPicks(window.currentTradingDate);
        }
        if (document.getElementById('page-star')?.classList.contains('active')) {
            if (window.renderTradingFavoritesInStarTab) window.renderTradingFavoritesInStarTab();
        }
        // NEW: Live Hub Page Re-render
        if (document.getElementById('page-live')?.classList.contains('active')) {
            loadLiveHubMatches();
        }

        // Global Badge Update - ONLY count TODAY's LIVE matches from MAJOR LEAGUES
        const today = new Date().toISOString().split('T')[0];
        const allMatches = Object.values(window.liveScoresHub);

        // Same leagues filter as in loadLiveHubMatches
        const MAJOR_LEAGUES = [
            135, 136, 39, 40, 41, 140, 78, 79, 61, 88, 94, 207, 235, 144, 203, 2, 3, 848, 137, 45, 143
        ];

        const todayLiveMatches = allMatches.filter(m => {
            const isToday = (m.matchDate || '').startsWith(today);
            const isLive = ['1H', '2H', 'HT', 'ET', 'P', 'LIVE', 'BT'].includes((m.status || '').toUpperCase());
            const isMajorLeague = !m.leagueId || MAJOR_LEAGUES.includes(m.leagueId);
            return isToday && isLive && isMajorLeague;
        });

        // De-duplicate by matchName
        const seen = new Set();
        const uniqueMatches = todayLiveMatches.filter(m => {
            const key = (m.matchName || '').toLowerCase().replace(/\s+/g, '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        const liveCount = uniqueMatches.length;
        const liveBadge = document.getElementById('live-badge');
        if (liveBadge) {
            if (liveCount > 0) {
                liveBadge.innerText = liveCount;
                liveBadge.classList.remove('hidden');
            } else {
                liveBadge.classList.add('hidden');
            }
        }
    });
}

function renderStrategies() {
    const container = document.getElementById('strategies-grid');
    if (!container) return;
    // container.innerHTML = ''; // MOVED TO ATOMIC replaceChildren

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

    const children = [];

    if (premium.length) {
        const sec = document.createElement('div');
        sec.className = 'col-span-full mb-2';
        sec.innerHTML = '<div class="text-sm font-bold text-purple-200 uppercase tracking-wide mb-3">✨ Strategie AI</div>';
        children.push(sec);
        premium.forEach(x => children.push(createStrategyBtn(x.id, x.strat, true)));
    }

    if (standard.length) {
        const sec = document.createElement('div');
        sec.className = 'col-span-full mt-4 mb-2';
        sec.innerHTML = '<div class="text-sm font-bold text-blue-200 uppercase tracking-wide mb-3 mt-5">📂 Strategie Fisse</div>';
        children.push(sec);
        standard.forEach(x => children.push(createStrategyBtn(x.id, x.strat, false)));
    }

    container.replaceChildren(...children);
}

function createStrategyBtn(id, strat, isPremium) {
    const btn = document.createElement('button');
    const isMagic = id.includes('magia');
    btn.className = `strategy-btn ${isMagic ? 'magic-ai' : ''} text-white rounded-xl p-4 shadow-lg w-full text-left relative overflow-hidden`;
    btn.onclick = () => window.showRanking(id, strat);

    btn.innerHTML = `
        <div class="relative z-10" >
            ${isPremium ? '<span class="text-[10px] bg-white/20 px-2 py-0.5 rounded font-black uppercase mb-2 inline-block">Pro</span>' : ''}
            <div class="text-xl font-black text-white drop-shadow-md">${strat.name}</div>
            <div class="text-xs text-white/80 font-semibold">${strat.totalMatches || strat.matches?.length || 0} Matches</div>
        </div>
        <div class="absolute right-[-10px] bottom-[-10px] text-6xl opacity-20 rotate-12">
            ${isMagic ? '🪄' : '⚽'}
        </div>
    `;
    return btn;
}

window.showRanking = function (stratId, strat, sortMode = 'score') {
    currentStrategyId = stratId; // CRITICAL: Set this BEFORE showPage to avoid infinite loop!
    window.showPage('ranking');
    const container = document.getElementById('matches-container');
    if (!container) return;
    document.getElementById('strategy-title').textContent = strat.name;

    // ANTI-FLICKER: Skip render if data hasn't changed
    const dataHash = getDataHash(strat.matches);
    if (_lastRenderCache.rankingHash === dataHash) {
        console.log('[Ranking Render] ⏭️ SKIPPED (data unchanged)');
        return;
    }
    _lastRenderCache.rankingHash = dataHash;

    if (!strat.matches || strat.matches.length === 0) {
        container.replaceChildren();
        const msg = document.createElement('div');
        msg.className = 'text-center py-10 text-gray-400';
        msg.textContent = 'Nessuna partita.';
        container.appendChild(msg);
    } else {
        console.log(`[Ranking Render] 📊 Filtering ${strat.matches.length} matches for stale ghosts...`);
        const filtered = strat.matches.filter(m => !isMatchStale(m));
        console.log(`[Ranking Render] ✅ After filtering: ${filtered.length} matches(removed ${strat.matches.length - filtered.length} ghosts)`);

        const sorted = [...filtered].sort((a, b) => {
            // ALWAYS sort by time as per user request to avoid UI instability
            return (a.ora || '').localeCompare(b.ora || '');
        });

        const cards = sorted.map((m, idx) => window.createUniversalCard(m, idx, stratId));
        console.log(`[Ranking Render] 🔄 Calling replaceChildren with ${cards.length} cards`);
        container.replaceChildren(...cards);
        console.log(`[Ranking Render] ✅ Render complete`);
    }
}

window.toggleFlag = async function (matchId) {
    let foundMatch = null;
    let sourceStrategyId = null;

    // Search in all loaded strategies and track which one provided the match
    if (window.strategiesData) {
        for (const [stratId, strat] of Object.entries(window.strategiesData)) {
            const matches = strat.matches || (Array.isArray(strat) ? strat : []);
            const m = matches.find(x => {
                const id = x.id || `${x.data}_${x.partita} `;
                return id === matchId;
            });
            if (m) {
                foundMatch = m;
                sourceStrategyId = stratId;
                break; // Stop searching once found
            }
        }
    }

    // Fallback: Check if already in selectedMatches
    if (!foundMatch) {
        foundMatch = window.selectedMatches.find(m => {
            const id = m.id || `${m.data}_${m.partita} `;
            return id === matchId;
        });
    }

    if (foundMatch) {
        // Ensure ID is consistent
        const consistentId = foundMatch.id || `${foundMatch.data}_${foundMatch.partita} `;

        const idx = window.selectedMatches.findIndex(m => (m.id || `${m.data}_${m.partita} `) === consistentId);

        if (idx >= 0) {
            window.selectedMatches.splice(idx, 1);
        } else {
            // CRITICAL: Save strategyId for proper live sync later
            window.selectedMatches.push({
                ...foundMatch,
                id: consistentId,
                strategyId: sourceStrategyId || currentStrategyId || 'all'
            });
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
        const btns = document.querySelectorAll(`button[data-match-id= "${matchId}"]`);
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
    // Account Page Injection Hook
    if (pageId === 'account') {
        if (typeof window.injectAccountPage === 'function') window.injectAccountPage();
        if (typeof window.populateAccountPage === 'function') window.populateAccountPage();
    }

    // If trying to show ranking without a strategy selected, default to 'all'
    if (pageId === 'ranking' && !currentStrategyId) {
        window.showRanking('all', window.strategiesData['all']);
        return; // Exit to prevent re-showing the page
    }

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

    // Normalize IDs: account button uses data-page="account", map to index.html ID
    const domId = pageId === 'account' ? 'account-page' : `page-${pageId}`;
    const pageEl = document.getElementById(domId);

    if (pageEl) pageEl.classList.add('active');
    window.scrollTo(0, 0);

    if (pageId === 'star' || pageId === 'my-matches') {
        window.showMyMatches();
        if (window.renderTradingFavoritesInStarTab) window.renderTradingFavoritesInStarTab();
        startTradingLiveRefresh();
    } else if (pageId === 'tips' || pageId === 'trading-sportivo') {
        loadTipsPage();
        startTradingLiveRefresh();
    } else if (pageId === 'history') {
        window.loadHistory();
    } else if (pageId === 'live') {
        loadLiveHubMatches();
    } else {
        if (tradingLiveInterval) clearInterval(tradingLiveInterval);
    }
};

window.updateMyMatchesCount = function () {
    const navBtn = document.querySelector('[data-page="star"]') || document.querySelector('[data-page="my-matches"]');
    if (!navBtn) return;

    let countBadge = navBtn.querySelector('.count-badge');

    // Only count Betting favorites (including Magia AI) filtered by DATE
    const bettingCount = (window.selectedMatches || []).filter(m => m.data === window.currentAppDate).length;
    const totalCount = bettingCount;

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

window.showMyMatches = function (sortMode = 'score') {
    const container = document.getElementById('my-matches-container');
    if (!container) return;

    // ANTI-FLICKER: Skip render if data hasn't changed
    const dataHash = getDataHash(window.selectedMatches);
    if (_lastRenderCache.myMatchesHash === dataHash) {
        console.log('[MyMatches Render] ⏭️ SKIPPED (data unchanged)');
        return;
    }
    _lastRenderCache.myMatchesHash = dataHash;

    // 1. Refresh scores from current strategiesData (if available)
    if (window.strategiesData) {
        window.selectedMatches = window.selectedMatches.map(sm => {
            const smId = sm.id || `${sm.data}_${sm.partita} `;
            let latestMatch = null;

            // STRATEGY-AWARE LOOKUP
            // 1. If it's a "Magia" strategy (any variation), check that specific list first/only to preserve its unique Tips.
            // 2. Otherwise, check 'all' (Source of Truth for standard matches).

            let sourceStrat = null;
            const isMagiaPick = sm.strategyId && sm.strategyId.toLowerCase().includes('magia');

            if (isMagiaPick) {
                // Try to find the exact Magia strategy loaded (could be ___magia_ai, magic_ai, etc.)
                // We search for a key in strategiesData that matches the saved ID or contains 'magia'
                sourceStrat = window.strategiesData[sm.strategyId] ||
                    Object.values(window.strategiesData).find(s => s.name && s.name.toLowerCase().includes('magia'));
            } else {
                sourceStrat = window.strategiesData['all'];
            }

            if (sourceStrat && sourceStrat.matches) {
                // Try Exact ID Match
                let found = sourceStrat.matches.find(m => (m.id || `${m.data}_${m.partita} `) === smId);

                // Fallback: Fuzzy Name Match
                if (!found) {
                    found = sourceStrat.matches.find(m => m.partita === sm.partita && m.data === sm.data);
                }

                if (found) {
                    latestMatch = found;
                }
            } else if (!isMagiaPick && window.strategiesData['all']) {
                // Double safety: if intended strategy not found, fallback to ALL for standard picks
                let found = window.strategiesData['all'].matches?.find(m => (m.id || `${m.data}_${m.partita} `) === smId);
                if (found) latestMatch = found;
            }

            if (latestMatch) {
                // Merge everything relevant for live status
                return {
                    ...sm,
                    risultato: latestMatch.risultato || null,
                    esito: latestMatch.esito || null,
                    liveData: latestMatch.liveData || null,
                    liveStats: latestMatch.liveStats || null,
                    minute: latestMatch.minute || latestMatch.liveData?.minute || null
                };
            }
            return sm;
        });
    }

    // 2. Filter Betting Matches by DATE & STALENESS
    const bettingMatches = (window.selectedMatches || []).filter(m => {
        return m.data === window.currentAppDate && !isMatchStale(m);
    });

    // Betting Favorites Section
    if (bettingMatches.length === 0) {
        const msg = document.createElement('div');
        msg.className = 'text-center text-gray-300 py-4 opacity-50';
        msg.textContent = 'Nessun pronostico salvato';
        container.replaceChildren(msg);
    } else {
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'mb-4';
        sectionHeader.innerHTML = '<div class="text-sm font-bold text-purple-300 flex items-center gap-2">⭐ PRONOSTICI SALVATI <span class="bg-purple-600 px-2 py-0.5 rounded text-xs">' + bettingMatches.length + '</span></div>';
        container.appendChild(sectionHeader);

        let sortedMatches = [...bettingMatches].sort((a, b) => {
            // ALWAYS sort by time as per user request to avoid UI instability
            if (!a.ora && !b.ora) return 0;
            if (!a.ora) return 1;
            if (!b.ora) return -1;
            return a.ora.localeCompare(b.ora);
        });

        const cards = sortedMatches.map((m, idx) => {
            try {
                const card = window.createUniversalCard(m, idx, m.strategyId || null, { detailedTrading: !!m.liveStats });

                // Replace flag button with delete button
                const flagBtn = card.querySelector('.flag-btn, button[data-match-id]');
                if (flagBtn) {
                    const matchId = m.id || `${m.data}_${m.partita} `;
                    flagBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
                    flagBtn.className = 'text-red-400 hover:text-red-600 transition text-xl ml-2';
                    flagBtn.onclick = (e) => {
                        e.stopPropagation();
                        window.removeMatch(matchId);
                    };
                }
                return card;
            } catch (e) {
                console.error('[showMyMatches] Error creating card:', e, m);
                return null;
            }
        }).filter(c => c !== null);

        container.replaceChildren(sectionHeader, ...cards);
    }
};

// Redundant sorting listeners removed as per request (Time is now the only sort)
// initMyMatchesListeners();

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
        const id = m.id || `${m.data}_${m.partita} `;
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
                // Sanitize to avoid "undefined" errors in Firestore
                const sanitizedMatches = JSON.parse(JSON.stringify(window.selectedMatches, (key, value) => {
                    return value === undefined ? null : value;
                }));

                await setDoc(doc(db, "users", window.currentUser.uid, "data", "selected_matches"), {
                    matches: sanitizedMatches,
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

        const strategyDefinitions = {
            'magia_ai': 'Studiata in TEMPO REALE dall\'AI (analisi LLM). Analizza pattern complessi e asimmetrie di quota.',
            'special_ai': 'Selezione ultra-precisa basata su algoritmi proprietari ad alta affidabilità.',
            'winrate_80': 'Solo partite con storico vittorie superiore all\'80%.',
            'ht_sniper': 'Trading professionale su Over 0.5 HT. Ingresso al minuto 20 se 0-0 con quota alta.',
            'second_half_surge': 'Trading professionale su Over 1.5 o 2.5 nel secondo tempo. Ingresso se il match è bloccato ma le statistiche mostrano pressione offensiva estrema.',
            'under_35_scalping': 'Trading difensivo: Scalping sulla quota Under 3.5 in match chiusi con bassa liquidità di gol.',
            'lay_the_draw': 'Trading Exchange: Bancata del pareggio in match con alta probabilità di vittoria di una delle due squadre.',
            'back_over_25': 'Trading su Over 2.5: Ingresso pre-match con uscita al primo gol.'
        };

        const liveTradingPersona = `Sei un esperto di TRADING SPORTIVO PROFESSIONALE.
Quando analizzi dati live(DA, SOG, xG), focalizzati su:
    1. Pressione offensiva(Goal Cooking).
2. Valore della quota rispetto al tempo rimanente.
3. Consigli operativi secchi(Entra, Resta, Cashout).
Mantieni un tono calmo, analitico e autorevole.`;

        let strategiesText = Object.entries(strategies)
            .map(([id, s]) => {
                const def = strategyDefinitions[id] || s.description || 'Analisi statistica.';
                return `- ** ${s.name}**: ${def} (${s.totalMatches || 0} partite).`;
            })
            .join('\n') || "Nessuna strategia caricata.";

        const basePrompt = eugenioPromptCache?.prompt ||
            `Ciao! Sono euGENIO, il tuo assistente AI esperto in scommesse e trading sportivo.
        ${liveTradingPersona}

Utilizzo modelli matematici(Poisson, Monte Carlo, Dixon - Coles) per trovare valore dove gli altri non lo vedono.
Ti chiami ${userName}.

ECCO IL CONTESTO ATTUALE DELL'APP:
        - Performance globale: ${stats.total} match analizzati, Winrate ${stats.winrate}%
            - Strategie attive oggi:
${strategiesText}

DEFINIZIONI STRATEGIE:
${Object.entries(strategyDefinitions).map(([k, v]) => `- ${k.toUpperCase()}: ${v}`).join('\n')}

    IMPORTANTE: Se vedi il "Goal Cooking Indicator" sopra il 70 %, significa che il gol è imminente statisticamente!
Sii sempre sincero: se un match non ha valore, dillo chiaramente.`;

        let prompt = `${basePrompt}

${eugenioPromptCache?.customInstructions || ''}
${eugenioPromptCache?.additionalContext || ''}
${eugenioPromptCache?.tradingKnowledge || ''}

Regole comportamentali:
    1. Saluta SOLO nel primo messaggio.
2. NON confondere Magia AI(tempo reale) con Special AI(precisione statistica).
3. Sii conciso e professionale.`;

        return prompt;
    }

    function toggleChat() {
        isOpen = !isOpen;
        if (isOpen) {
            chatWindow.classList.remove('hidden');
            toggleBtn.classList.add('hidden');
            setTimeout(() => input.focus(), 100);

            if (!hasWelcomed) {
                const welcomeMsg = `Ciao ${getUserName()} ! 👋 Sono euGENIO 🧞‍♂️. Come posso aiutarti oggi ? `;
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
        div.className = `flex ${sender === 'user' ? 'justify-end' : 'justify-start'} `;
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
        div.innerHTML = `<div class="bg-white border border-gray-200 rounded-2xl rounded-tl-none p-3 shadow-sm" >
        <div class="flex gap-1">
            <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
            <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0.2s"></div>
            <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0.4s"></div>
        </div>
        </div> `;
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


// ==================== HISTORY (7 DAYS) LOGIC ====================
window.loadHistory = async function () {
    const container = document.getElementById('history-list');
    if (!container) return;
    container.innerHTML = '<div class="text-center text-gray-400 py-8">Caricamento storico...</div>';

    try {
        const today = new Date();
        const dates = [];

        // Last 7 COMPLETE days
        for (let i = 1; i <= 8; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            dates.push(date.toISOString().split('T')[0]);
        }

        const dateData = [];
        for (const date of dates) {
            try {
                const docSnap = await getDoc(doc(db, "daily_strategies", date));
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    const strategies = data.strategies || {};
                    let totalWins = 0, totalLosses = 0, totalPending = 0;

                    Object.values(strategies).forEach(strat => {
                        (strat.matches || []).forEach(m => {
                            if (m.esito === 'Vinto') totalWins++;
                            else if (m.esito === 'Perso') totalLosses++;
                            else totalPending++;
                        });
                    });

                    dateData.push({ date, strategies, totalWins, totalLosses, totalPending, hasData: true });
                } else {
                    dateData.push({ date, hasData: false });
                }
            } catch (e) {
                console.error(`Error loading history for ${date}: `, e);
                dateData.push({ date, hasData: false });
            }
        }

        if (dateData.length === 0) {
            container.innerHTML = '<div class="text-center text-gray-400 py-8">Nessuno storico disponibile</div>';
            return;
        }

        container.innerHTML = dateData.map((data, index) => createHistoryDateCard(data, index)).join('');

        // Listeners for expand/collapse
        dateData.forEach((data, index) => {
            if (data.hasData) {
                const card = container.querySelector(`[data-date= "${data.date}"]`);
                card.addEventListener('click', () => toggleDateDetails(data.date, data.strategies, card));
            }
        });

    } catch (e) {
        console.error('[History] Error:', e);
        container.innerHTML = '<div class="text-center text-red-400 py-8">Errore storico</div>';
    }
};

function createHistoryDateCard(data, index) {
    const { date, totalWins, totalLosses, totalPending, hasData } = data;
    const dateObj = new Date(date + 'T12:00:00');
    const dayName = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'][dateObj.getDay()];
    const dayNum = dateObj.getDate();
    const monthName = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'][dateObj.getMonth()];

    if (!hasData) {
        return `<div class="bg-gray-800/50 rounded-xl p-4 opacity-50 mb-3" > <div class="flex justify-between"><div><div class="text-sm text-gray-500">${dayName}, ${dayNum} ${monthName}</div></div><div class="text-sm text-gray-500">Nessun dato</div></div></div> `;
    }

    const totalMatches = totalWins + totalLosses;
    const winrate = totalMatches > 0 ? Math.round((totalWins / totalMatches) * 100) : 0;
    let winrateColor = winrate >= 70 ? 'text-green-400' : (winrate >= 50 ? 'text-yellow-400' : 'text-red-400');

    return `
        <div data-date="${date}" class="bg-gradient-to-r from-blue-900/50 to-purple-900/50 rounded-xl p-4 cursor-pointer hover:scale-[1.02] transition-transform mb-3" >
            <div class="flex items-center justify-between mb-2">
                <div class="text-lg font-bold">${dayName}, ${dayNum} ${monthName}</div>
                <div class="text-right">
                    <div class="text-2xl font-black ${winrateColor}">${winrate}%</div>
                    <div class="text-[10px] text-gray-400 uppercase">winrate</div>
                </div>
            </div>
            <div class="flex items-center gap-4 text-sm font-bold">
                <span class="text-green-400">🟢 ${totalWins}V</span>
                <span class="text-red-400">🔴 ${totalLosses}P</span>
                ${totalPending > 0 ? `<span class="text-gray-400">⏳ ${totalPending}</span>` : ''}
            </div>
            <div id="details-${date}" class="hidden mt-4 pt-4 border-t border-white/20"></div>
        </div>
        `;
}

function toggleDateDetails(date, strategies, card) {
    const container = card.querySelector(`#details-${date} `);
    if (!container.classList.contains('hidden')) { container.classList.add('hidden'); return; }

    container.innerHTML = Object.entries(strategies).map(([id, strat]) => {
        const matches = strat.matches || [];
        const closed = matches.filter(m => m.risultato);
        if (closed.length === 0) return '';

        let wins = 0, losses = 0;
        closed.forEach(m => { m.esito === 'Vinto' ? wins++ : losses++; });
        const wr = Math.round((wins / (wins + losses)) * 100);
        let wrColor = wr >= 70 ? 'text-green-400' : (wr >= 50 ? 'text-yellow-400' : 'text-red-400');

        return `
        <div class="strategy-card bg-white/10 rounded-lg p-3 mb-2" data-strategy="${id}" data-date="${date}" >
                <div class="flex justify-between items-center cursor-pointer" onclick="event.stopPropagation(); window.toggleStrategyMatchesHistory('${id}', '${date}', this)">
                    <div>
                        <div class="font-bold text-purple-300">${strat.name || id}</div>
                        <div class="text-[10px] text-gray-400">${wins}V - ${losses}P</div>
                    </div>
                    <div class="text-right">
                        <div class="text-xl font-black ${wrColor}">${wr}%</div>
                    </div>
                </div>
                <div id="matches-${id}-${date}" class="hidden mt-3 pt-3 border-t border-white/10 space-y-2">
                    ${closed.map(m => `
                        <div class="${m.esito === 'Vinto' ? 'bg-green-600/30' : 'bg-red-600/30'} p-2 rounded text-xs flex justify-between items-center">
                            <div><div class="font-bold">${m.partita}</div><div class="opacity-70">${m.tip} (@${m.quota || '-'})</div></div>
                            <div class="text-right font-black">${m.risultato} ${m.esito === 'Vinto' ? '✅' : '❌'}</div>
                        </div>
                    `).join('')}
                </div>
            </div> `;
    }).join('');
    container.classList.remove('hidden');
}

window.toggleStrategyMatchesHistory = function (id, date, el) {
    const container = el.parentElement.querySelector(`#matches-${id}-${date} `);
    container.classList.toggle('hidden');
};

window.loadTradingHistory = async function () {
    const container = document.getElementById('trading-history-list');
    if (!container) return;
    container.innerHTML = '<div class="text-center text-gray-400 py-8">Caricamento trading...</div>';

    try {
        const today = new Date();
        const dates = [];
        for (let i = 0; i <= 7; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            dates.push(date.toISOString().split('T')[0]);
        }

        const dateData = [];
        for (const date of dates) {
            const docSnap = await getDoc(doc(db, "daily_trading_picks", date));
            if (docSnap.exists()) {
                const picks = docSnap.data().picks || [];
                let v = 0, c = 0, s = 0, p = 0;
                picks.forEach(x => {
                    if (x.esitoColor === 'green') v++;
                    else if (x.esitoColor === 'yellow') c++;
                    else if (x.esitoColor === 'red') s++;
                    else p++;
                });
                dateData.push({ date, picks, v, c, s, p, hasData: true });
            } else {
                dateData.push({ date, hasData: false });
            }
        }

        container.innerHTML = dateData.map(d => {
            if (!d.hasData || d.picks.length === 0) return `<div class="bg-gray-800/50 rounded-xl p-4 opacity-50 mb-3 text-sm text-gray-500" > ${d.date}: Nessun dato</div> `;
            return `
        <div class="bg-gradient-to-r from-orange-900/40 to-red-900/40 border border-orange-500/20 rounded-xl p-4 mb-3 cursor-pointer" onclick= "this.querySelector('.details').classList.toggle('hidden')" >
                    <div class="flex justify-between items-center">
                        <div class="font-bold">${d.date}</div>
                        <div class="flex gap-1">
                            ${'🟢'.repeat(d.v)}${'🟡'.repeat(d.c)}${'🔴'.repeat(d.s)}
                        </div>
                    </div>
                    <div class="details hidden mt-4 space-y-2">
                        ${d.picks.map(x => `
                            <div class="bg-white/5 p-2 rounded text-xs flex justify-between">
                                <div><div class="font-bold">${x.partita}</div><div>${x.strategy} - ${x.tip}</div></div>
                                <div class="text-right uppercase font-bold text-gray-400">${x.risultato || '-'}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>`;
        }).join('');
    } catch (e) {
        console.error(e);
        container.innerHTML = 'Errore caricamento.';
    }
};

// Event Listeners for History Tabs
const initHistoryTabs = () => {
    const tabPronostici = document.getElementById('history-tab-pronostici');
    const tabTrading = document.getElementById('history-tab-trading');
    const listPronostici = document.getElementById('history-list');
    const listTrading = document.getElementById('trading-history-list');

    if (tabPronostici && tabTrading) {
        tabPronostici.onclick = () => {
            tabPronostici.className = 'flex-1 py-3 px-4 rounded-xl font-bold text-sm transition-all bg-gradient-to-r from-purple-600 to-blue-600 text-white shadow-lg';
            tabTrading.className = 'flex-1 py-3 px-4 rounded-xl font-bold text-sm transition-all bg-gray-700 text-gray-300 hover:bg-gray-600';
            listPronostici.classList.remove('hidden');
            listTrading.classList.add('hidden');
        };
        tabTrading.onclick = () => {
            tabTrading.className = 'flex-1 py-3 px-4 rounded-xl font-bold text-sm transition-all bg-gradient-to-r from-orange-500 to-red-500 text-white shadow-lg';
            tabPronostici.className = 'flex-1 py-3 px-4 rounded-xl font-bold text-sm transition-all bg-gray-700 text-gray-300 hover:bg-gray-600';
            listTrading.classList.remove('hidden');
            listPronostici.classList.add('hidden');
            window.loadTradingHistory();
        };
    }
};
initHistoryTabs();

// ==================== LIVE HUB COMMAND CENTER (EX SERIE A) ====================
async function loadLiveHubMatches() {
    const container = document.getElementById('live-hub-container');
    if (!container) return;

    const allGames = Object.values(window.liveScoresHub);

    // FILTER: Only matches from TODAY
    const today = new Date().toISOString().split('T')[0]; // "2026-01-04"
    const todayGames = allGames.filter(match => {
        const matchDate = match.matchDate || '';
        return matchDate === today || matchDate.startsWith(today);
    });

    // FILTER: Only LIVE or recent matches (not FT from hours ago)
    let liveGames = todayGames.filter(match => {
        const status = (match.status || '').toUpperCase();
        // Show: NS (not started), 1H, 2H, HT, ET, P, LIVE, or FT within last 30 min
        if (['NS', '1H', '2H', 'HT', 'ET', 'P', 'LIVE', 'BT'].includes(status)) return true;
        if (status === 'FT') {
            // Keep FT matches for 30 minutes after ending for review
            const updatedAt = match.updatedAt?.toDate?.() || new Date(match.updatedAt);
            const minsSinceUpdate = (Date.now() - updatedAt.getTime()) / 60000;
            return minsSinceUpdate < 30;
        }
        return false;
    });

    // DE-DUPLICATION: Remove duplicate matches by normalized matchName
    const seenMatches = new Map();
    liveGames = liveGames.filter(match => {
        // Normalize: lowercase, remove spaces, sort team names alphabetically
        const name = (match.matchName || '').toLowerCase().replace(/\s+/g, '');
        // Create a stable key regardless of home/away order
        const teams = name.split(/vs|-|:/).map(t => t.trim()).sort().join('_');
        if (seenMatches.has(teams)) {
            console.log(`[LiveHub] Skipping duplicate: ${match.matchName}`);
            return false;
        }
        seenMatches.set(teams, true);
        return true;
    });

    // FILTER: Only MAJOR LEAGUES (Serie A/B, Premier, La Liga, Bundesliga, etc.)
    const MAJOR_LEAGUES = [
        135, 136,       // Italia: Serie A, Serie B
        39, 40, 41,     // Inghilterra: Premier League, Championship, League One
        140,            // Spagna: La Liga
        78, 79,         // Germania: Bundesliga, 2. Bundesliga
        61,             // Francia: Ligue 1
        88,             // Olanda: Eredivisie
        94,             // Portogallo: Primeira Liga
        207,            // Svizzera: Super League
        235,            // Austria: Bundesliga
        144,            // Belgio: Pro League
        203,            // Turchia: Super Lig
        2, 3, 848,      // Coppe Europee: UCL, UEL, Conference League
        137, 45, 143    // Coppe Nazionali: Coppa Italia, FA Cup, Copa del Rey
    ];

    const majorLeagueGames = liveGames.filter(match => {
        // If no leagueId, allow it (old data without leagueId)
        if (!match.leagueId) return true;
        return MAJOR_LEAGUES.includes(match.leagueId);
    });

    console.log(`[LiveHub] All: ${allGames.length}, Today: ${todayGames.length}, Unique: ${liveGames.length}, Major Leagues: ${majorLeagueGames.length}`);

    if (majorLeagueGames.length === 0) {
        container.innerHTML = `
            <div class="col-span-full text-center py-20 bg-white/10 backdrop-blur-md border border-white/20 rounded-3xl">
                <i class="fa-solid fa-radar text-6xl mb-4 text-white/30 animate-pulse"></i>
                <p class="font-black text-xl text-white">Nessun match attivo oggi</p>
                <p class="text-sm text-white/60 mt-2 max-w-xs mx-auto">Il radar sta scansionando i campionati principali. Torna più tardi!</p>
            </div>`;
        return;
    }

    // SORT: By status (LIVE first), then by kickoff time or pressure
    const sorted = [...majorLeagueGames].sort((a, b) => {
        const statusOrder = { '1H': 1, '2H': 1, 'HT': 2, 'LIVE': 1, 'ET': 1, 'P': 1, 'BT': 2, 'NS': 3, 'FT': 4 };
        const orderA = statusOrder[a.status?.toUpperCase()] || 5;
        const orderB = statusOrder[b.status?.toUpperCase()] || 5;
        if (orderA !== orderB) return orderA - orderB;

        // If same status, sort by pressure (high first for live) or time
        const pA = a.liveStats?.pressureValue || 0;
        const pB = b.liveStats?.pressureValue || 0;
        return pB - pA;
    });

    let html = '';
    sorted.forEach(match => {
        html += renderLiveHubCard(match);
    });
    container.innerHTML = html;
}



window.toggleLiveFavorite = async function (matchName, tip) {
    if (!window.currentUser) return alert("Accedi per attivare i preferiti");

    const isTrading = tip && (tip.toLowerCase().includes('back') || tip.toLowerCase().includes('lay'));

    if (isTrading) {
        // Construct Trading ID: trading_normalizedname
        const mKey = `trading_${matchName.toLowerCase().replace(/\s+/g, '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, '')}`;
        await window.toggleTradingFavorite(mKey);
    } else {
        // Search for this match in all strategies to find its ID
        let matchId = null;
        if (window.strategiesData) {
            for (const stratId in window.strategiesData) {
                const found = window.strategiesData[stratId].matches?.find(m => m.partita === matchName);
                if (found) {
                    matchId = found.id || `${found.data}_${found.partita}`;
                    break;
                }
            }
        }

        if (matchId) {
            await window.toggleFlag(matchId);
        } else {
            console.warn("[LiveHub] Betting match ID not found for:", matchName);
            // If not found in strategies, we can't toggle flag easily because we don't know the strategy source
            alert("Per attivare notifiche di questo match, selezionalo dalla scheda Strategie.");
        }
    }
    // Force re-render of Live Hub to update star status
    window.loadLiveHubMatches();
};

// --- NUOVO RENDERER LIVE UNIVERSALE - REDESIGN v2 ---
function renderLiveHubCard(match) {
    const stats = match.liveStats || {};
    const pressure = stats.pressureValue || 0;
    const xgHome = stats.xg?.home || 0;
    const xgAway = stats.xg?.away || 0;

    // Split score
    const score = match.score || "0-0";
    const [scH, scA] = score.split('-');

    // Team names - prefer direct fields, fallback to parsing matchName
    let homeTeam = match.homeTeam || '';
    let awayTeam = match.awayTeam || '';
    const matchName = match.matchName || '';

    if (!homeTeam || !awayTeam) {
        if (matchName.includes(' vs ')) {
            const parts = matchName.split(' vs ');
            homeTeam = homeTeam || parts[0]?.trim() || 'Casa';
            awayTeam = awayTeam || parts[1]?.trim() || 'Trasferta';
        } else if (matchName.includes(' - ')) {
            const parts = matchName.split(' - ');
            homeTeam = homeTeam || parts[0]?.trim() || 'Casa';
            awayTeam = awayTeam || parts[1]?.trim() || 'Trasferta';
        }
    }

    // Team logos
    const homeLogo = match.homeLogo || null;
    const awayLogo = match.awayLogo || null;
    const homeLogoHtml = homeLogo ? `<img src="${homeLogo}" alt="${homeTeam}" class="w-8 h-8 object-contain" onerror="this.style.display='none'">` : '';
    const awayLogoHtml = awayLogo ? `<img src="${awayLogo}" alt="${awayTeam}" class="w-8 h-8 object-contain" onerror="this.style.display='none'">` : '';

    // Pressure bar color - HIGH CONTRAST (no yellow on white!)
    let pressureColor = 'bg-slate-400';
    let pressureText = 'text-slate-600';
    if (pressure > 30) { pressureColor = 'bg-amber-500'; pressureText = 'text-amber-700'; }
    if (pressure > 60) { pressureColor = 'bg-orange-600'; pressureText = 'text-orange-700'; }
    if (pressure > 85) { pressureColor = 'bg-red-600 animate-pulse'; pressureText = 'text-red-700'; }

    // Events Rendering
    const eventsHtml = renderLiveEvents(match.events || []);

    // Status display
    const status = (match.status || 'LIVE').toUpperCase();
    const elapsed = match.elapsed || '?';
    let statusLabel = `LIVE ${elapsed}'`;
    let statusClass = 'bg-red-500 text-white';
    if (status === 'FT') { statusLabel = 'FINITA'; statusClass = 'bg-slate-600 text-white'; }
    else if (status === 'HT') { statusLabel = 'INTERVALLO'; statusClass = 'bg-amber-500 text-white'; }
    else if (status === 'NS') { statusLabel = 'DA INIZIARE'; statusClass = 'bg-blue-500 text-white'; }

    // Trading badge - check if match is from trading
    const isTrading = match.tip && (match.tip.toLowerCase().includes('back') || match.tip.toLowerCase().includes('lay'));
    const tradingBadge = isTrading ? `<span class="px-2 py-0.5 bg-purple-600 text-white text-[8px] font-bold rounded-full uppercase">Trading</span>` : '';

    // Tip display
    const tipBadge = match.tip ? `<span class="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-[9px] font-bold rounded-full">${match.tip}</span>` : '';

    // Check if flagged for Star display
    let isFlagged = false;
    const cleanName = matchName.toLowerCase().replace(/\s+/g, '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, '');
    if (isTrading) {
        isFlagged = window.tradingFavorites?.includes(`trading_${cleanName}`);
    } else {
        isFlagged = window.selectedMatches?.some(m => (m.partita || '').toLowerCase().replace(/\s+/g, '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, '') === cleanName);
    }

    return `
        <div class="rounded-2xl overflow-hidden shadow-lg mb-4 flex flex-col bg-white border border-slate-200">
        <!-- Header: Status & Trading Badge -->
        <div class="flex justify-between items-center px-3 py-2 bg-gradient-to-r from-indigo-600 to-purple-600">
            <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 ${statusClass} rounded text-[10px] font-black uppercase">${statusLabel}</span>
                ${tradingBadge}
                <button onclick="window.toggleLiveFavorite('${matchName.replace(/'/g, "\\'")}', '${match.tip || ''}')" class="ml-1 text-white hover:text-yellow-300 transition-all">
                    <i class="${isFlagged ? 'fa-solid text-yellow-300' : 'fa-regular text-white/80'} fa-star text-sm"></i>
                </button>
            </div>
            <span class="text-[9px] font-semibold text-white/80">${match.matchDate || ''}</span>
        </div>

        <!-- Body: Teams & Score with Logos -->
        <div class="px-3 py-3">
            <div class="flex items-center justify-between gap-2">
                <!-- Home Team -->
                <div class="flex-1 flex flex-col items-center gap-1">
                    ${homeLogoHtml}
                    <h3 class="text-xs font-bold leading-tight text-slate-800 text-center line-clamp-2">${homeTeam}</h3>
                </div>
                <!-- Score -->
                <div class="flex items-center gap-1 bg-slate-800 px-3 py-2 rounded-xl">
                    <span class="text-2xl font-black text-white">${scH}</span>
                    <span class="text-lg font-bold text-slate-400">:</span>
                    <span class="text-2xl font-black text-white">${scA}</span>
                </div>
                <!-- Away Team -->
                <div class="flex-1 flex flex-col items-center gap-1">
                    ${awayLogoHtml}
                    <h3 class="text-xs font-bold leading-tight text-slate-800 text-center line-clamp-2">${awayTeam}</h3>
                </div>
            </div>

            <!-- Tip Badge -->
            <div class="flex justify-center mt-2 gap-2">
                ${tipBadge}
            </div>

            <!-- Pressure Indicator -->
            <div class="mt-3">
                <div class="flex justify-between items-center mb-1">
                    <span class="text-[10px] font-bold ${pressureText} uppercase flex items-center gap-1">
                        <i class="fa-solid fa-fire"></i> Pressione Gol
                    </span>
                    <span class="text-[11px] font-black ${pressureText}">${pressure}%</span>
                </div>
                <div class="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div class="h-full rounded-full transition-all duration-1000 ${pressureColor}" style="width: ${Math.min(pressure, 100)}%"></div>
                </div>
            </div>
        </div>

        <!-- Stats Grid - Larger fonts -->
        <div class="grid grid-cols-3 gap-1 px-3 py-2 bg-slate-50 border-t border-slate-200">
            <div class="text-center">
                <div class="text-[9px] font-bold text-indigo-600 uppercase">xG</div>
                <div class="text-sm font-black text-slate-800">${xgHome.toFixed(1)} - ${xgAway.toFixed(1)}</div>
            </div>
            <div class="text-center">
                <div class="text-[9px] font-bold text-orange-600 uppercase">Attacchi</div>
                <div class="text-sm font-black text-slate-800">${stats.dangerousAttacks || '0 - 0'}</div>
            </div>
            <div class="text-center">
                <div class="text-[9px] font-bold text-emerald-600 uppercase">Possesso</div>
                <div class="text-sm font-black text-slate-800">${stats.possession || '50% - 50%'}</div>
            </div>
        </div>

        <!-- Events Timeline -->
        <div class="px-3 py-2 bg-white border-t border-slate-200">
             <div class="flex items-center gap-1 mb-1">
                <i class="fa-solid fa-list text-[10px] text-slate-500"></i>
                <span class="text-[9px] font-bold text-slate-500 uppercase">Eventi</span>
             </div>
             <div class="space-y-1 overflow-y-auto max-h-20 text-slate-700 text-[11px]">
                ${eventsHtml || '<span class="italic text-slate-400">In attesa di eventi...</span>'}
             </div>
        </div>

        <!-- AI Insight -->
        <div class="px-3 py-2 bg-gradient-to-r from-indigo-50 to-purple-50 border-t border-indigo-200">
            <div class="flex items-start gap-2">
                <div class="w-7 h-7 rounded-full bg-white border-2 border-indigo-300 flex items-center justify-center text-sm shadow">🧞</div>
                <div class="flex-1">
                    <p class="text-[11px] text-slate-700 leading-snug mb-2">
                        ${generateLiveInsight(match)}
                    </p>
                    <button onclick="window.getLiveTradingAnalysis('${matchName}')" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-2 rounded-lg text-[10px] font-black uppercase tracking-wide transition-all flex items-center justify-center gap-1 shadow">
                        <i class="fa-solid fa-brain"></i> Analisi Profonda
                    </button>
                </div>
            </div>
        </div>
    </div> `;
}

function renderLiveEvents(events) {
    if (!events || events.length === 0) return '';
    // Reverse to show latest first
    const sorted = [...events].sort((a, b) => parseInt(b.time?.elapsed || 0) - parseInt(a.time?.elapsed || 0));

    return sorted.map(ev => {
        const time = ev.time?.elapsed || '?';
        const type = ev.type || '';
        const detail = ev.detail || '';
        const player = ev.player?.name || '';
        const assist = ev.assist?.name ? ` (ass.${ev.assist.name})` : '';

        let icon = '⏱️';
        let label = '';
        let color = 'text-gray-400';

        if (type.toUpperCase() === 'GOAL') {
            icon = '⚽';
            label = `<span class="font-black text-white" > GOAL!</span> ${player}${assist} `;
            color = 'text-green-400';
        } else if (type.toUpperCase() === 'CARD') {
            if (detail.toUpperCase().includes('YELLOW')) {
                icon = '🟨';
                label = `Giallo: ${player} `;
                color = 'text-yellow-400';
            } else {
                icon = '🟥';
                label = `Rosso: ${player} `;
                color = 'text-red-400';
            }
        } else if (type.toUpperCase() === 'VAR') {
            icon = '🖥️';
            label = `VAR: ${detail.replace('Goal cancelled', 'Gol annullato').replace('Penalty confirmed', 'Rigore confermato')} `;
            color = 'text-blue-300';
        } else if (type.toUpperCase() === 'SUBST') {
            return ''; // Hide substitutions to keep it clean
        } else {
            label = `${type}: ${detail} `;
        }

        return `
        <div class="flex items-center gap-2 text-[10px] ${color} animate-fade-in relative pl-2" >
                <span class="w-6 font-bold text-gray-500">${time}'</span>
                <span class="text-xs">${icon}</span>
                <span class="flex-1 truncate">${label}</span>
            </div>
        `;
    }).join('');
}

function generateLiveInsight(match) {
    const stats = match.liveStats || {};
    const pressure = stats.pressureValue || 0;
    const elapsed = parseInt(match.elapsed);
    const xgH = stats.xg?.home || 0;
    const xgA = stats.xg?.away || 0;
    const evalStatus = (match.evaluation || "").toUpperCase();
    const score = match.score || "0-0";
    const [scH, scA] = score.split('-').map(Number);

    // 1. Situazioni Critiche (Valutazione Backend)
    if (evalStatus === 'CASH_OUT') {
        return `⚠️ ** Cash Out suggerito! ** La dinamica del match è cambiata.Proteggi il profitto o limita l'exposure.`;
    }
    if (evalStatus === 'STOP_LOSS') {
        return `❌ **Stop Loss hit.** Condizioni di mercato non più favorevoli per questa operazione.`;
    }

    // 2. Dinamica di Pressione e Goal Cooking
    if (pressure > 85) {
        return `🚀 **Pressure Alert!** Valore ${pressure}% estremo. L'attacco è costante, il gol è imminente. Ottimo per Over Live.`;
    }

    // 3. Analisi XG (Expected Goals) vs Risultato Reale
    if (xgH > scH + 1.2 && pressure > 60) {
        return `🔥 **Under-performing Casa:** La squadra di casa meriterebbe almeno un altro gol basandosi sugli xG (${xgH}). Pressione alta, spingi sull'Over.`;
    }
    if (xgA > scA + 1.2 && pressure > 60) {
        return `🔥 **Under-performing Trasferta:** Ospiti molto pericolosi (${xgA} xG). Il pareggio o il raddoppio è nell'aria.`;
    }

    // 4. Analisi Sniper (Match bloccati con alta pressione)
    if (elapsed > 15 && elapsed < 35 && score === '0-0' && pressure > 50) {
        return `🎯 **Sniper Window:** Match ancora bloccato ma con ottimi volumi di gioco. Valuta ingresso 0.5 HT nei prossimi minuti.`;
    }

    // 5. Surge Alert (Second Half)
    if (elapsed > 65 && elapsed < 80 && pressure > 70) {
        return `⚡ **Surge Alert!** Fase finale ad alta intensità. Le difese sono stanche, mercato Over 0.5 ST molto invitante.`;
    }

    // Default
    if (evalStatus === 'WIN' || evalStatus === 'VINTO') {
        return `✅ **In controllo.** Il match sta seguendo il trend previsto. Monitoraggio attivo per eventuali reverse.`;
    }

    return `🧐 **Analisi in corso:** Scansione trend e flussi di gioco. euGENIO ti avviserà se rilevo anomalie o opportunità Sniper.`;
}

// Add CSS for glass cards
const style = document.createElement('style');
style.textContent = `
    .glass-card {
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    }
    .custom-scrollbar::-webkit-scrollbar {
        width: 3px;
    }
    .custom-scrollbar::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.05);
    }
    .custom-scrollbar::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 10px;
    }
`;
document.head.appendChild(style);

console.log('[App] Live Terminal Logic Initialized.');

console.log('[App] Logic Initialized.');

// ==================== ACCOUNT PAGE POPULATION ====================

window.populateAccountPage = async function () {
    if (!window.currentUser) return;
    const p = window.currentUserProfile || {};
    const u = window.currentUser || {};

    // Profile Baselines
    const name = p.name || u.displayName || u.email?.split('@')[0] || 'Utente';
    const email = u.email || p.email || '-';

    let createdTimestamp = '-';
    const rawCreated = p.createdAt || p.registeredAt || u.metadata?.creationTime;
    if (rawCreated) {
        try {
            const date = rawCreated.toDate ? rawCreated.toDate() : new Date(rawCreated);
            createdTimestamp = date.toLocaleDateString('it-IT');
        } catch (e) { console.warn("Created date error", e); }
    }

    // Populate UI (Targeting IDs from index.html)
    const elName = document.getElementById('account-name');
    const elEmail = document.getElementById('account-email');
    const elAvatar = document.getElementById('account-avatar');
    const elCreated = document.getElementById('account-created');

    console.log('[Account] UI Elements:', { elName, elEmail, elAvatar, elCreated });
    console.log('[Account] Data to set:', { name, email, createdTimestamp });

    if (elName) elName.textContent = name;
    if (elEmail) elEmail.textContent = email;
    if (elAvatar) elAvatar.textContent = name.charAt(0).toUpperCase();
    if (elCreated) elCreated.textContent = createdTimestamp;

    // Telegram UI
    const telegramCondition = p.telegramLinked || p.telegramChatId;
    const elNotLinked = document.getElementById('telegram-not-linked');
    const elLinked = document.getElementById('telegram-linked');

    if (telegramCondition) {
        elNotLinked?.classList.add('hidden');
        elLinked?.classList.remove('hidden');
        const elUser = document.getElementById('telegram-username');
        if (elUser) elUser.textContent = p.telegramUsername ? `@${p.telegramUsername} ` : 'Attivo';

        // Checkbox states
        if (document.getElementById('notify-kickoff')) document.getElementById('notify-kickoff').checked = p.notifyKickoff !== false;
        if (document.getElementById('notify-goal')) document.getElementById('notify-goal').checked = p.notifyGoal !== false;
        if (document.getElementById('notify-result')) document.getElementById('notify-result').checked = p.notifyResult !== false;
        if (document.getElementById('notify-live')) document.getElementById('notify-live').checked = p.notifyLive !== false;
    } else {
        elNotLinked?.classList.remove('hidden');
        elLinked?.classList.add('hidden');
    }

    // --- Listeners (Attach once) ---
    if (window.accountListenersInitialized) return;

    // Nickname Update
    document.getElementById('edit-nickname-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newNick = document.getElementById('edit-nickname-input').value.trim();
        if (!newNick) return;
        try {
            await setDoc(doc(db, "users", window.currentUser.uid), { name: newNick }, { merge: true });
            alert("Nickname aggiornato! Ricarica la pagina per vederlo dappertutto.");
            location.reload();
        } catch (err) { console.error(err); alert("Ops, errore salvataggio."); }
    });

    // Telegram Code Generation
    document.getElementById('generate-telegram-code-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('generate-telegram-code-btn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Attendere...';
        try {
            const generateFn = httpsCallable(functions, 'generateTelegramLinkCode');
            const res = await generateFn();
            document.getElementById('telegram-link-code').textContent = res.data.code;
            document.getElementById('telegram-code-display').classList.remove('hidden');
        } catch (err) { console.error(err); alert("Errore generazione codice."); }
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-link"></i> Genera Codice';
    });

    // Telegram Notifications Toggle
    ['notify-kickoff', 'notify-goal', 'notify-result', 'notify-live'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', async (e) => {
            const dbField = id === 'notify-kickoff' ? 'notifyKickoff' :
                id === 'notify-goal' ? 'notifyGoal' :
                    id === 'notify-result' ? 'notifyResult' : 'notifyLive';
            try {
                await setDoc(doc(db, "users", window.currentUser.uid), { [dbField]: e.target.checked }, { merge: true });
            } catch (err) { console.error(err); }
        });
    });

    // Unlink Telegram
    document.getElementById('unlink-telegram-btn')?.addEventListener('click', async () => {
        if (!confirm("Scollegare il bot Telegram? Non riceverai più notifiche.")) return;
        try {
            await setDoc(doc(db, "users", window.currentUser.uid), {
                telegramLinked: false,
                telegramChatId: null,
                telegramUsername: null
            }, { merge: true });
            alert("Telegram scollegato.");
            location.reload();
        } catch (err) { console.error(err); }
    });

    window.accountListenersInitialized = true;
};

