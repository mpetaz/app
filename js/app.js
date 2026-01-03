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
let strategiesUnsubscribe = null; // For real-time betting updates
let liveHubUnsubscribe = null; // For unified live scores hub
let serieARefreshInterval = null; // Refresh for Serie A section
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

window.getLiveTradingAnalysis = async function (matchId) {
    // Find match data
    let match = null;
    if (window.selectedMatches) {
        match = window.selectedMatches.find(m => (m.id || `${m.data}_${m.partita}`) === matchId);
    }

    if (!match) {
        // Search in trading results if not in favorites
        const today = new Date().toISOString().split('T')[0];
        // This is a bit complex since trading picks are usually in currentTradingPicks state
        // Let's assume for now it's in a window variable or we find it in the UI
        alert("Analizzando i dati live... euGENIO sta elaborando. 🧞‍♂️");
    }

    const elapsed = (match?.liveData?.elapsed || match?.minute || 0).toString().replace("'", "");
    const score = match?.liveData?.score || match?.risultato || "0-0";
    const stats = match?.liveStats || {};

    // Build stats string properly
    const da = stats.dangerousAttacks || "N/A";
    const sog = stats.shotsOnGoal || "N/A";
    const xg = stats.xg ? `${stats.xg.home} - ${stats.xg.away}` : "N/A";
    const pos = stats.possession || "N/A";

    const prompt = `Analizza questo match LIVE per un'operazione di TRADING SPORTIVO:
- Match: ${match?.partita}
- Minuto: ${elapsed}'
- Risultato: ${score}
- Strategia Originale: ${match?.strategy} ${match?.tip}
- Statistiche Pro: DA:${da}, SOG:${sog}, xG:${xg}, Possesso:${pos}

Fornisci un'analisi professionale in max 3-4 righe. Usa termini tecnici da Pro Trader (es. liquidity, exposure, weight on market). Concludi con un consiglio chiaro tra:
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

    // Over/Under logic
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

    // Trading: Lay The Draw
    if (t.includes("lay the draw") || t.includes("lay draw") || t.includes("laythedraw")) return gH !== gA ? 'Vinto' : 'Perso';
    // Trading: Back Over 2.5
    if (t.includes("back over") || t.includes("backover")) return total >= 3 ? 'Vinto' : 'Perso';

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
    const liveHubData = window.liveScoresHub[hubId];
    // DEBUG: Active to trace hubId lookups
    console.log(`[CardDebug] Looking for hubId: "${hubId}" | Found: ${!!liveHubData} | HubSize: ${Object.keys(window.liveScoresHub).length}`);

    if (liveHubData) {
        match = {
            ...match,
            risultato: liveHubData.score,
            status: liveHubData.status,
            minute: liveHubData.elapsed,
            esito: liveHubData.evaluation === 'WIN' ? 'Vinto' : (liveHubData.evaluation === 'LOSE' ? 'Perso' : liveHubData.evaluation),
            liveData: {
                ...match.liveData,
                score: liveHubData.score,
                elapsed: liveHubData.elapsed,
                status: liveHubData.status
            },
            liveStats: liveHubData.liveStats || match.liveStats,
            events: liveHubData.events || match.events
        };
    } else if (match.risultato && match.risultato.includes('-')) {
        // FALLBACK: Match has a result in local data but not in Hub (API didn't match it)
        // Calculate esito locally using the same logic as Backend
        const localEsito = evaluateTipLocally(mTip, match.risultato);
        if (localEsito) {
            match = { ...match, esito: localEsito, status: 'FT', isNotMonitored: true };
            console.log(`[CardDebug] LOCAL FALLBACK: ${mName} | tip: ${mTip} | risultato: ${match.risultato} -> esito: ${localEsito}`);
        }
    } else if (!liveHubData && !match.risultato) {
        // No Hub data AND no local result = Not monitored by API
        match = { ...match, isNotMonitored: true };
    }

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
    // Color coding based on result (DARKER/VIVID colors) - ONLY for FINISHED matches
    let esitoClass = '';
    const isFinished = match.status === 'FT' || match.status === 'AET' || match.status === 'PEN';
    if (isFinished && match.esito === 'Vinto') esitoClass = 'bg-gradient-to-b from-green-200 to-green-300 border-green-400 ring-2 ring-green-300';
    else if (isFinished && match.esito === 'Perso') esitoClass = 'bg-gradient-to-b from-red-200 to-red-300 border-red-400 ring-2 ring-red-300';
    else if (isFinished && match.esito === 'CASH_OUT') esitoClass = 'bg-gradient-to-b from-yellow-200 to-yellow-300 border-yellow-400 ring-2 ring-yellow-300';
    else if (isFinished && match.esito === 'PUSH') esitoClass = 'bg-gradient-to-b from-gray-200 to-gray-300 border-gray-400 ring-2 ring-gray-300';
    // DEBUG: Log esito and esitoClass for FT matches
    if (match.status === 'FT' || liveHubData?.status === 'FT') {
        console.log(`[EsitoDebug] ${mName} | evaluation: ${liveHubData?.evaluation} | esito: ${match.esito} | esitoClass: ${esitoClass ? 'SET' : 'EMPTY'}`);
    }

    card.className = `match-card rounded-xl shadow-lg fade-in mb-3 overflow-hidden bg-white border border-gray-100 relative ${esitoClass} ${isFlagged && isTrading ? 'ring-2 ring-emerald-500' : ''}`;

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

    if (isTrading && options.detailedTrading && match.liveData) {
        headerHTML = `
            <div class="${headerClass} p-3 flex justify-between items-center text-white relative">
                 <div class="flex items-center gap-2">
                    ${headerIcon}
                    <span class="font-bold text-sm tracking-wider uppercase">${headerTitle}</span>
                    ${isRealTimeMatch ? '<span class="bg-blue-500/80 text-[9px] px-2 py-0.5 rounded-full font-black ml-1 animate-pulse">🕒 REAL TIME</span>' : ''}
                </div>
                <div class="flex items-center gap-3">
                    <div class="flex items-center gap-2">
                        ${isLive ? '<span class="text-red-400 font-bold text-xs">● LIVE</span>' : ''}
                        <div class="text-xl font-black font-mono">${elapsed}'</div>
                    </div>
                    ${flagBtnHTML}
                </div>
                <!-- Goal Cooking Bar (UI 2.0) -->
                ${isLive ? `
                <div class="absolute bottom-0 left-0 h-1 bg-white/20 w-full overflow-hidden">
                    <div class="h-full bg-yellow-400 goal-cooking-bar" style="width: ${calculateGoalCookingPressure(match.liveStats, elapsed)}%"></div>
                </div>` : ''}
            </div>
        `;
    } else {
        headerHTML = `
            <div class="${headerClass} p-3 flex justify-between items-center text-white relative">
                <div class="flex items-center gap-2">
                    ${headerIcon}
                    <span class="font-bold text-sm tracking-wider uppercase">${headerTitle}</span>
                    ${isRealTimeMatch && isLive ? '<span class="bg-blue-500/80 text-[9px] px-2 py-0.5 rounded-full font-black ml-1">🕒 REAL TIME</span>' : ''}
                </div>
                <div class="flex items-center gap-2">
                    ${match.ora ? `<span class="text-xs bg-white/20 px-2 py-0.5 rounded font-bold">⏰ ${match.ora}</span>` : ''}
                    ${flagBtnHTML}
                </div>
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
                             </div>` : '');

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

    // TRADING: Live Stats & Sniper Trigger
    if (isTrading && options.detailedTrading && match.liveStats) {
        const pos = typeof match.liveStats.possession === 'object'
            ? `${match.liveStats.possession.home}% - ${match.liveStats.possession.away}%`
            : (match.liveStats.possession || '0% - 0%');

        const pressure = calculateGoalCookingPressure(match.liveStats, match.liveData?.elapsed || match.liveData?.minute || 0);
        // Sniper trigger moved to background/Telegram, simplified UI here
        const isSniperTrigger = (match.strategy === 'HT_SNIPER' && (match.liveData?.elapsed >= 15 && match.liveData?.elapsed <= 25) && (match.liveData?.score === '0-0'));

        insightsHTML += `
            <div class="px-4 mb-3">
                ${isSniperTrigger ? `
                <div class="bg-indigo-600/10 border border-indigo-200 text-indigo-700 text-[10px] font-bold p-2 rounded-lg mb-2 flex items-center justify-between">
                    <span>🎯 FINESTRA OPERATIVA SNIPER ATTIVA</span>
                    <i class="fa-solid fa-clock"></i>
                </div>` : ''}

                <div class="bg-gray-900 rounded-xl p-3 border border-gray-800 mb-2">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-[9px] font-bold text-gray-500 uppercase">Goal Cooking Indicator</span>
                        <span class="text-[10px] font-black ${pressure > 70 ? 'text-orange-400' : 'text-blue-400'}">${pressure}%</span>
                    </div>
                    <div class="h-2 bg-gray-800 rounded-full overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-blue-500 via-yellow-400 to-red-500 goal-cooking-fill" style="width: ${pressure}%"></div>
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
            const time = ev.time || ev.minute || 0;
            const icon = renderEventIcon(ev.type, ev.detail);
            const detail = ev.detail || ev.player?.name || "";

            return `
                        <div class="flex items-center gap-2 bg-gray-50 border border-gray-100 rounded-lg p-1.5 text-[10px] shadow-sm">
                            <span class="font-black text-gray-400 w-6">${time}'</span>
                            <span class="text-sm">${icon}</span>
                            <span class="font-bold text-gray-700 truncate">${detail}</span>
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

    // --- Footer with Not Monitored badge ---
    const notMonitoredBadge = match.isNotMonitored ?
        '<span class="text-[9px] font-bold text-orange-500 uppercase tracking-widest bg-orange-100 px-2 py-0.5 rounded-full">⚠️ Non monitorata</span>' : '';
    const footerHTML = `
        <div class="bg-gray-50 p-2 border-t border-gray-100 flex justify-between items-center px-4">
              ${notMonitoredBadge}
              ${isTrading ? '<span class="text-[9px] font-bold text-gray-300 uppercase tracking-widest">Trading Pick</span>' : '<span class="text-[9px] font-bold text-gray-300 uppercase tracking-widest">Standard Pick</span>'}
        </div>
    `;

    // 05 HT Logic (Restored with Probability)
    const htHTML = match.info_ht && match.info_ht.trim() !== '' ? (() => {
        const htMatch = match.info_ht.match(/(\d+)%.*?@?([\d.,]+)/);
        const htProb = htMatch ? htMatch[1] : '';
        const htQuota = htMatch ? htMatch[2] : '';

        return `
            <div class="mx-4 mb-3 bg-purple-50 border border-purple-200 rounded-lg p-2">
                <div class="text-[10px] font-bold text-purple-700 flex justify-between items-center">
                    <span>⚽ Gol nel Primo Tempo (0.5 HT)</span>
                    <div class="flex items-center gap-2">
                        ${htProb ? `<span class="bg-purple-200 px-2 py-0.5 rounded text-purple-800 font-black">${htProb}%</span>` : ''}
                        ${htQuota ? `<span class="bg-purple-100 px-2 py-0.5 rounded text-purple-900 font-black">@${htQuota}</span>` : ''}
                    </div>
                </div>
            </div>`;
    })() : '';
    insightsHTML += htHTML;

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
                let sig = signalsMap[pickId] || signalsMap[`trading_${pickId}`] || signalsMap[pickId.replace('trading_', '')];

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

            window.renderTradingCards(mergedPicks);

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
    container.innerHTML = '';

    if (picks.length === 0) {
        document.getElementById('trading-empty').classList.remove('hidden');
        return;
    }

    // 1. Filter
    let filtered = [...picks];
    if (tradingFilterState === 'live') {
        filtered = picks.filter(p => (p.liveData?.elapsed || p.liveData?.minute || 0) > 0);
    } else if (tradingFilterState === 'favs') {
        filtered = picks.filter(p => (window.tradingFavorites || []).includes(window.getTradingPickId(p.partita)));
    }

    if (filtered.length === 0) {
        container.innerHTML = `<div class="text-center py-10 text-gray-500 italic">Nessuna partita in questa categoria.</div>`;
        return;
    }

    // 2. Smart Sorting
    // Group 1: Fav + Live
    // Group 2: Live
    // Group 3: Fav
    // Group 4: Others
    const getPriority = (p) => {
        const isFav = (window.tradingFavorites || []).includes(window.getTradingPickId(p.partita));
        const isLive = (p.liveData?.elapsed || p.liveData?.minute || 0) > 0;
        if (isFav && isLive) return 1;
        if (isLive) return 2;
        if (isFav) return 3;
        return 4;
    };

    filtered.sort((a, b) => getPriority(a) - getPriority(b));

    document.getElementById('trading-empty').classList.add('hidden');

    filtered.forEach(pick => {
        const isFav = (window.tradingFavorites || []).includes(window.getTradingPickId(pick.partita));
        const isLive = (pick.liveData?.elapsed || pick.liveData?.minute || 0) > 0;

        const card = window.createUniversalCard(pick, 0, null, { isTrading: true, detailedTrading: true });

        // Final Polish: If it's the "Royal Tie" (Fav + Live), add a special border
        if (isFav && isLive) {
            card.classList.add('ring-2', 'ring-emerald-400', 'shadow-lg', 'shadow-emerald-500/20');
        } else if (isLive) {
            card.classList.add('border-l-4', 'border-l-red-500');
        }

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
    if (container) container.innerHTML = '';
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
                    window.showRanking(currentStrategyId, window.strategiesData[currentStrategyId], currentSortMode);
                }
                if (document.getElementById('page-my-matches')?.classList.contains('active')) {
                    window.showMyMatches(currentSortMode);
                }
            } else {
                console.warn("No data for date:", targetDate);
                // Try fallback logic only if it's the first load
                if (!dateToLoad) {
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

        console.log(`[LiveHub] Sync complete. ${Object.keys(window.liveScoresHub).length} active updates.`);

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
    });
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
    let sourceStrategyId = null;

    // Search in all loaded strategies and track which one provided the match
    if (window.strategiesData) {
        for (const [stratId, strat] of Object.entries(window.strategiesData)) {
            const matches = strat.matches || (Array.isArray(strat) ? strat : []);
            const m = matches.find(x => {
                const id = x.id || `${x.data}_${x.partita}`;
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
    const pageEl = document.getElementById(`page-${pageId}`);
    if (pageEl) pageEl.classList.add('active');
    window.scrollTo(0, 0);

    if (pageId === 'star' || pageId === 'my-matches') {
        window.showMyMatches();
        if (window.renderTradingFavoritesInStarTab) window.renderTradingFavoritesInStarTab();
        startTradingLiveRefresh();
    } else if (pageId === 'trading' || pageId === 'trading-sportivo') {
        startTradingLiveRefresh();
    } else if (pageId === 'history') {
        window.loadHistory();
    } else if (pageId === 'serie-a') {
        loadSerieAMatches();
        if (serieARefreshInterval) clearInterval(serieARefreshInterval);
        serieARefreshInterval = setInterval(loadSerieAMatches, 30000);
    } else {
        if (tradingLiveInterval) clearInterval(tradingLiveInterval);
        if (serieARefreshInterval) clearInterval(serieARefreshInterval);
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

    container.innerHTML = '';

    // 1. Refresh scores from current strategiesData (if available)
    if (window.strategiesData) {
        window.selectedMatches = window.selectedMatches.map(sm => {
            const smId = sm.id || `${sm.data}_${sm.partita}`;
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
                let found = sourceStrat.matches.find(m => (m.id || `${m.data}_${m.partita}`) === smId);

                // Fallback: Fuzzy Name Match
                if (!found) {
                    found = sourceStrat.matches.find(m => m.partita === sm.partita && m.data === sm.data);
                }

                if (found) {
                    latestMatch = found;
                }
            } else if (!isMagiaPick && window.strategiesData['all']) {
                // Double safety: if intended strategy not found, fallback to ALL for standard picks
                let found = window.strategiesData['all'].matches?.find(m => (m.id || `${m.data}_${m.partita}`) === smId);
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

    // 2. Filter Betting Matches by DATE (New Fix)
    // Only show matches that belong to the currently viewed date (window.currentAppDate)
    const bettingMatches = (window.selectedMatches || []).filter(m => {
        // Assume m.data is "YYYY-MM-DD". If missing, we might show it or hide it.
        // Better to hide if we want strict date sync.
        return m.data === window.currentAppDate;
    });

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
                const card = window.createUniversalCard(m, idx, m.strategyId || null, { detailedTrading: !!m.liveStats });

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

// Initialize listeners for sorting in my-matches page
const initMyMatchesListeners = () => {
    const btnScore = document.getElementById('my-matches-sort-score');
    const btnTime = document.getElementById('my-matches-sort-time');

    if (btnScore && btnTime) {
        btnScore.onclick = () => {
            btnScore.className = 'flex-1 bg-purple-600 text-white py-2 px-4 rounded-lg font-semibold text-sm';
            btnTime.className = 'flex-1 bg-gray-700 text-gray-300 py-2 px-4 rounded-lg font-semibold text-sm';
            window.showMyMatches('score');
        };
        btnTime.onclick = () => {
            btnTime.className = 'flex-1 bg-purple-600 text-white py-2 px-4 rounded-lg font-semibold text-sm';
            btnScore.className = 'flex-1 bg-gray-700 text-gray-300 py-2 px-4 rounded-lg font-semibold text-sm';
            window.showMyMatches('time');
        };
    }
};
initMyMatchesListeners();

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
            'lay_the_draw': 'Trading Exchange: Bancata del pareggio in match con alta probabilità di vittoria di una delle due squadre.',
            'back_over_25': 'Trading su Over 2.5: Ingresso pre-match con uscita al primo gol.'
        };

        const liveTradingPersona = `Sei un esperto di TRADING SPORTIVO PROFESSIONALE.
Quando analizzi dati live (DA, SOG, xG), focalizzati su:
1. Pressione offensiva (Goal Cooking).
2. Valore della quota rispetto al tempo rimanente.
3. Consigli operativi secchi (Entra, Resta, Cashout).
Mantieni un tono calmo, analitico e autorevole.`;

        let strategiesText = Object.entries(strategies)
            .map(([id, s]) => {
                const def = strategyDefinitions[id] || s.description || 'Analisi statistica.';
                return `- **${s.name}**: ${def} (${s.totalMatches || 0} partite).`;
            })
            .join('\n') || "Nessuna strategia caricata.";

        const basePrompt = eugenioPromptCache?.prompt ||
            `Ciao! Sono euGENIO, il tuo assistente AI esperto in scommesse e trading sportivo.
${liveTradingPersona}

Utilizzo modelli matematici (Poisson, Monte Carlo, Dixon-Coles) per trovare valore dove gli altri non lo vedono.
Ti chiami ${userName}.

ECCO IL CONTESTO ATTUALE DELL'APP:
- Performance globale: ${stats.total} match analizzati, Winrate ${stats.winrate}%
- Strategie attive oggi:
${strategiesText}

DEFINIZIONI STRATEGIE:
${Object.entries(strategyDefinitions).map(([k, v]) => `- ${k.toUpperCase()}: ${v}`).join('\n')}

IMPORTANTE: Se vedi il "Goal Cooking Indicator" sopra il 70%, significa che il gol è imminente statisticamente!
Sii sempre sincero: se un match non ha valore, dillo chiaramente.`;

        let prompt = `${basePrompt}

${eugenioPromptCache?.customInstructions || ''}
${eugenioPromptCache?.additionalContext || ''}
${eugenioPromptCache?.tradingKnowledge || ''}

Regole comportamentali:
1. Saluta SOLO nel primo messaggio.
2. NON confondere Magia AI (tempo reale) con Special AI (precisione statistica).
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
                console.error(`Error loading history for ${date}:`, e);
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
                const card = container.querySelector(`[data-date="${data.date}"]`);
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
        return `<div class="bg-gray-800/50 rounded-xl p-4 opacity-50 mb-3"><div class="flex justify-between"><div><div class="text-sm text-gray-500">${dayName}, ${dayNum} ${monthName}</div></div><div class="text-sm text-gray-500">Nessun dato</div></div></div>`;
    }

    const totalMatches = totalWins + totalLosses;
    const winrate = totalMatches > 0 ? Math.round((totalWins / totalMatches) * 100) : 0;
    let winrateColor = winrate >= 70 ? 'text-green-400' : (winrate >= 50 ? 'text-yellow-400' : 'text-red-400');

    return `
        <div data-date="${date}" class="bg-gradient-to-r from-blue-900/50 to-purple-900/50 rounded-xl p-4 cursor-pointer hover:scale-[1.02] transition-transform mb-3">
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
    const container = card.querySelector(`#details-${date}`);
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
            <div class="strategy-card bg-white/10 rounded-lg p-3 mb-2" data-strategy="${id}" data-date="${date}">
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
            </div>`;
    }).join('');
    container.classList.remove('hidden');
}

window.toggleStrategyMatchesHistory = function (id, date, el) {
    const container = el.parentElement.querySelector(`#matches-${id}-${date}`);
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
            if (!d.hasData || d.picks.length === 0) return `<div class="bg-gray-800/50 rounded-xl p-4 opacity-50 mb-3 text-sm text-gray-500">${d.date}: Nessun dato</div>`;
            return `
                <div class="bg-gradient-to-r from-orange-900/40 to-red-900/40 border border-orange-500/20 rounded-xl p-4 mb-3 cursor-pointer" onclick="this.querySelector('.details').classList.toggle('hidden')">
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

// ==================== SERIE A LIVE RESTORED ====================
async function loadSerieAMatches() {
    const container = document.getElementById('serie-a-live-container');
    if (!container) return;

    console.log('[Serie A] Loading matches...');

    try {
        const q = query(
            collection(db, "serie_a_matches"),
            where("status", "in", ["NOT_STARTED", "LIVE", "FINISHED"])
        );
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            console.warn('[Serie A] No specialized matches found, trying fallback from strategies...');
            const fallbackResults = [];
            const seen = new Set();

            if (window.strategiesData) {
                Object.values(window.strategiesData).forEach(strat => {
                    if (strat.matches && Array.isArray(strat.matches)) {
                        strat.matches.forEach(m => {
                            const lega = (m.lega || "").toLowerCase();
                            if ((lega.includes('italy') && lega.includes('serie a')) || (lega === 'serie a')) {
                                const key = `${m.partita}_${m.ora}`;
                                if (!seen.has(key)) {
                                    seen.add(key);
                                    fallbackResults.push(m);
                                }
                            }
                        });
                    }
                });
            }

            if (fallbackResults.length > 0) {
                console.log(`[Serie A] Found ${fallbackResults.length} matches in fallback.`);
                let fallbackHTML = '';
                fallbackResults.forEach(m => {
                    fallbackHTML += renderFallbackSerieACard(m);
                });
                container.innerHTML = fallbackHTML;
                return;
            }

            container.innerHTML = `
                <div class="text-center py-12 text-gray-300">
                    <i class="fa-solid fa-calendar-xmark text-5xl mb-4 opacity-50"></i>
                    <p class="font-bold text-lg">Nessuna partita di Serie A oggi</p>
                    <p class="text-xs text-gray-500 mt-2">Le partite verranno caricate la mattina</p>
                </div>`;
            return;
        }

        const matches = [];
        snapshot.forEach(doc => matches.push(doc.data()));

        matches.sort((a, b) => {
            if (a.status === "LIVE" && b.status !== "LIVE") return -1;
            if (a.status !== "LIVE" && b.status === "LIVE") return 1;
            if (a.status === "FINISHED" && b.status !== "FINISHED") return 1;
            if (a.status !== "FINISHED" && b.status === "FINISHED") return -1;
            return new Date(a.kickoffTime) - new Date(b.kickoffTime);
        });

        let matchesHTML = '';
        matches.forEach(match => {
            if (match.status === "NOT_STARTED") {
                matchesHTML += renderPreMatchCard(match);
            } else {
                matchesHTML += renderLiveMatchCard(match);
            }
        });

        container.innerHTML = matchesHTML;

    } catch (e) {
        console.error('[Serie A] Error:', e);
        container.innerHTML = '<div class="text-center text-red-400 py-12">Errore caricamento Serie A.</div>';
    }
}

function renderPreMatchCard(match) {
    const kickoffDate = new Date(match.kickoffTime);
    const timeStr = kickoffDate.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const homeForm = match.homeTeam?.form || "-----";
    const awayForm = match.awayTeam?.form || "-----";

    return `
        <div class="bg-gradient-to-br from-blue-50 to-purple-50 rounded-2xl p-5 shadow-lg border-2 border-blue-200 mb-4">
            <div class="flex items-center justify-between mb-4">
                <span class="bg-blue-600 text-white px-3 py-1 rounded-full text-xs font-bold">🕐 ${timeStr}</span>
                <span class="bg-purple-100 text-purple-700 px-3 py-1 rounded-full text-xs font-bold">PRE-MATCH</span>
            </div>
            <div class="text-center mb-5">
                <h3 class="text-xl font-black text-gray-900">${match.matchName}</h3>
                <p class="text-xs text-gray-500 mt-1">🏆 ${match.lega}</p>
            </div>
            <div class="grid grid-cols-2 gap-4 mb-5">
                <div class="bg-white rounded-xl p-3 border border-gray-200 text-center">
                    <img src="${match.homeTeam.logo}" class="w-14 h-14 mx-auto mb-2">
                    <p class="font-bold text-sm text-gray-900">${match.homeTeam.name}</p>
                    <div class="text-xs text-gray-500 mt-2 space-y-1">
                        <div><span class="font-semibold">C:</span> ${formatFormLast5(homeForm, true)}</div>
                        <div class="grid grid-cols-2 gap-1 mt-1">
                            <div><span class="text-gray-400">G:</span> <span class="font-bold text-green-600">${match.homeTeam.goalsScored}</span></div>
                            <div><span class="text-gray-400">S:</span> <span class="font-bold text-red-600">${match.homeTeam.goalsConceded}</span></div>
                        </div>
                    </div>
                </div>
                <div class="bg-white rounded-xl p-3 border border-gray-200 text-center">
                    <img src="${match.awayTeam.logo}" class="w-14 h-14 mx-auto mb-2">
                    <p class="font-bold text-sm text-gray-900">${match.awayTeam.name}</p>
                    <div class="text-xs text-gray-500 mt-2 space-y-1">
                        <div><span class="font-semibold">T:</span> ${formatFormLast5(awayForm, false)}</div>
                        <div class="grid grid-cols-2 gap-1 mt-1">
                            <div><span class="text-gray-400">G:</span> <span class="font-bold text-green-600">${match.awayTeam.goalsScored}</span></div>
                            <div><span class="text-gray-400">S:</span> <span class="font-bold text-red-600">${match.awayTeam.goalsConceded}</span></div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="bg-gradient-to-r from-purple-600 to-purple-500 rounded-xl p-4 text-center text-white shadow-lg">
                <p class="text-xs opacity-90 mb-1">💡 TIP CONSIGLIATA</p>
                <div class="flex flex-col items-center justify-center">
                    <p class="text-lg font-black">${match.recommendedTip}</p>
                    ${match.recommendedTipOdd ? `<p class="text-xs bg-white text-purple-700 px-2 py-0.5 rounded-full mt-1 font-bold">@${match.recommendedTipOdd}</p>` : ''}
                </div>
            </div>
        </div>`;
}

function renderLiveMatchCard(match) {
    const score = match.score || "0-0";
    const elapsed = match.elapsed || "0'";
    const scoreHT = match.scoreHT ? `(HT: ${match.scoreHT})` : "";
    const isFinished = match.status === "FINISHED";
    const liveStats = match.liveStats || {};
    const possession = liveStats.possession || "50% - 50%";
    const shotsOnGoal = liveStats.shotsOnGoal || "0 - 0";
    const dangerousAttacks = liveStats.dangerousAttacks || "0 - 0";
    const pressure = liveStats.pressure || "NORMAL";

    let cardClass = isFinished
        ? (calcTipResult(match.recommendedTip, score) === 'WIN' ? "bg-emerald-900 border-emerald-500" : "bg-rose-900 border-rose-500")
        : "bg-blue-900 border-blue-500 animate-pulse-slow";

    return `
        <div class="${cardClass} rounded-2xl p-5 border-2 mb-4 text-white">
            <div class="flex items-center justify-between mb-4">
                <span class="bg-white/20 px-3 py-1 rounded-full text-[10px] font-bold">${isFinished ? '🏁 FINALE' : '🔵 LIVE'}</span>
                ${!isFinished ? `<span class="font-bold text-sm">${elapsed}</span>` : ''}
            </div>
            <div class="text-center mb-4">
                <h3 class="text-xl font-black">${match.matchName}</h3>
                <p class="text-xs text-blue-200 mt-1">🏆 Serie A</p>
            </div>
            <div class="bg-black/30 rounded-xl p-4 mb-4 text-center">
                <p class="text-4xl font-black mb-1">${score}</p>
                <p class="text-xs text-blue-100 font-bold">${scoreHT}</p>
            </div>
            <div class="bg-white/10 rounded-xl p-3 border border-white/10">
                <div class="flex justify-between text-xs font-bold mb-1">
                    <span>Possesso</span>
                    <span>${possession}</span>
                </div>
                <div class="h-1.5 bg-white/10 rounded-full overflow-hidden mb-3">
                    <div class="h-full bg-blue-400" style="width: ${parseInt(possession) || 50}%"></div>
                </div>
                <div class="grid grid-cols-2 gap-4 text-center">
                    <div><p class="text-[10px] opacity-60 uppercase">Tiri in Porta</p><p class="text-sm font-bold">${shotsOnGoal}</p></div>
                    <div><p class="text-[10px] opacity-60 uppercase">Attacchi Peric.</p><p class="text-sm font-bold">${dangerousAttacks}</p></div>
                </div>
            </div>
        </div>`;
}

function calcTipResult(tip, score) {
    if (!tip || !score) return 'UNKNOWN';
    const [h, a] = score.split('-').map(Number);
    const total = h + a;
    const t = tip.toUpperCase();

    if (t === '1') return h > a ? 'WIN' : 'LOSE';
    if (t === 'X') return h === a ? 'WIN' : 'LOSE';
    if (t === '2') return a > h ? 'WIN' : 'LOSE';
    if (t.startsWith('+') || t.startsWith('OVER')) {
        const val = parseFloat(t.replace('+', '').replace('OVER', ''));
        return total > val ? 'WIN' : 'LOSE';
    }
    return 'UNKNOWN';
}

function formatFormLast5(form, isHome) {
    if (!form || form === "-----") return "-----";
    return form.slice(-5).split('').map(c => c === 'W' ? '🟢' : c === 'D' ? '🟡' : '🔴').join('');
}

function renderFallbackSerieACard(match) {
    return `
        <div class="bg-white/10 rounded-2xl p-5 border border-white/20 mb-4 text-white">
            <div class="flex items-center justify-between mb-4">
                <span class="bg-gray-600 px-3 py-1 rounded-full text-[10px] font-bold">FALLBACK</span>
                <span class="text-xs font-bold">⏰ ${match.ora || '?'}</span>
            </div>
            <div class="text-center mb-4">
                <h3 class="text-lg font-bold">${match.partita}</h3>
                <p class="text-[10px] text-gray-400 mt-1 uppercase">🏆 ${match.lega}</p>
            </div>
            <div class="flex justify-center gap-4">
                <div class="bg-white/5 rounded-lg p-3 text-center min-w-[100px]">
                    <p class="text-[10px] text-gray-400 mb-1">TIP</p>
                    <p class="font-bold text-yellow-400">${match.tip || '-'}</p>
                </div>
                <div class="bg-white/5 rounded-lg p-3 text-center min-w-[100px]">
                    <p class="text-[10px] text-gray-400 mb-1">PROB</p>
                    <p class="font-bold text-cyan-400">${match.probabilita || '-'}%</p>
                </div>
            </div>
            <div class="mt-4 text-center">
                <p class="text-[10px] text-gray-500 italic">Dati specializzati Serie A non disponibili temporaneamente.</p>
            </div>
        </div>`;
}

console.log('[App] Logic Initialized.');

// ==================== ACCOUNT PAGE INJECTION ====================

window.injectAccountPage = function () {
    if (document.getElementById('page-account')) return;

    console.log('[Account] Injecting Account Page HTML...');
    const accountDiv = document.createElement('div');
    accountDiv.id = 'page-account';
    accountDiv.className = 'page hidden container mx-auto px-4 py-6 pb-24';

    accountDiv.innerHTML = `
        <h2 class="text-2xl font-bold mb-6 text-white">Il Mio Account</h2>
        <div class="stat-card rounded-xl p-6 mb-4">
             <div class="flex items-center gap-4 mb-6">
                 <div id="account-avatar" class="bg-gradient-to-br from-purple-600 to-blue-600 w-16 h-16 rounded-full flex items-center justify-center text-white text-2xl font-black">?</div>
                 <div>
                     <h3 class="text-xl font-bold text-gray-800" id="account-name">-</h3>
                     <p class="text-gray-600 text-sm" id="account-email">-</p>
                 </div>
             </div>
             <div class="mb-4">
                 <p class="text-xs text-gray-500 mt-1">Registrato il <span id="account-created">-</span></p>
             </div>
        </div>

        <div class="stat-card rounded-xl p-6 mt-4">
             <h3 class="font-bold mb-3 text-lg text-gray-800 flex items-center gap-2">
                 <i class="fa-brands fa-telegram text-blue-500"></i> Notifiche Telegram
             </h3>
             <div id="telegram-not-linked" class="space-y-3">
                 <p class="text-sm text-gray-600">Collega Telegram per ricevere notifiche sui goal!</p>
                 <button id="generate-telegram-code-btn" class="bg-blue-500 text-white px-4 py-2 rounded-lg font-bold text-sm hover:bg-blue-600 transition flex items-center gap-2">
                     <i class="fa-solid fa-link"></i> Genera Codice
                 </button>
                 <div id="telegram-code-display" class="hidden bg-blue-50 border border-blue-200 rounded-lg p-4 mt-3">
                     <p class="text-sm text-gray-700 mb-2">Il tuo codice:</p>
                     <div class="flex items-center gap-2">
                         <span id="telegram-link-code" class="text-2xl font-mono font-bold text-blue-600 tracking-wider"></span>
                     </div>
                     <p class="text-xs text-gray-500 mt-2">Apri <a href="https://t.me/TipsterAI_Live_Bot" target="_blank" class="text-blue-500 underline">@TipsterAI_Live_Bot</a> e invia: <code class="bg-gray-200 px-1 rounded">/start CODICE</code></p>
                 </div>
             </div>
             <div id="telegram-linked" class="hidden space-y-3">
                 <div class="flex items-center gap-2 text-green-600"><i class="fa-solid fa-check-circle"></i> <span class="font-semibold">Collegato!</span> <span id="telegram-username"></span></div>
             </div>
        </div>
    `;

    const mainContainer = document.querySelector('main') || document.body;
    mainContainer.appendChild(accountDiv);

    // Attach Listener: Generate Code
    document.getElementById('generate-telegram-code-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('generate-telegram-code-btn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generando...';
        try {
            // Check if httpsCallable is available via window scope (if imported as module it might not be global)
            // But we are inside the module here.
            // Assumption: functions (from import) is available inclosure.
            // If not, we might need window.firebase functions helper.
            // But since this code is IN app.js, it has access to top-level vars.

            // To be safe, re-get functions if needed, but 'functions' var is at line 11.
            const generateFn = httpsCallable(functions, 'generateTelegramLinkCode');
            const res = await generateFn();
            const code = res.data.code;
            document.getElementById('telegram-link-code').textContent = code;
            document.getElementById('telegram-code-display').classList.remove('hidden');
        } catch (e) {
            console.error(e);
            alert('Errore generazione codice: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-link"></i> Genera Codice';
        }
    });
};

window.populateAccountPage = function () {
    // Use currentUserProfile if available, fallback to currentUser (auth object)
    const p = window.currentUserProfile || {};
    const u = window.currentUser || {};

    const name = p.name || u.displayName || u.email?.split('@')[0] || 'Utente';
    const email = p.email || u.email || '-';

    const elName = document.getElementById('account-name');
    if (elName) elName.textContent = name;

    const elEmail = document.getElementById('account-email');
    if (elEmail) elEmail.textContent = email;

    const elAvatar = document.getElementById('account-avatar');
    if (elAvatar) elAvatar.textContent = name.charAt(0).toUpperCase();

    const elCreated = document.getElementById('account-created');
    // Try multiple date fields and handle Firestore Timestamp
    const createdTimestamp = p.createdAt || p.registeredAt || u.metadata?.creationTime;
    if (elCreated && createdTimestamp) {
        try {
            let d;
            if (typeof createdTimestamp === 'string') {
                d = new Date(createdTimestamp);
            } else if (createdTimestamp.toDate) {
                d = createdTimestamp.toDate(); // Firestore Timestamp
            } else {
                d = new Date(createdTimestamp);
            }
            elCreated.textContent = d.toLocaleDateString('it-IT');
        } catch (e) {
            elCreated.textContent = '-';
        }
    }

    if (p.telegramLinked) {
        document.getElementById('telegram-not-linked')?.classList.add('hidden');
        document.getElementById('telegram-linked')?.classList.remove('hidden');
        const elTele = document.getElementById('telegram-username');
        if (elTele) elTele.textContent = p.telegramUsername ? `@${p.telegramUsername}` : '';
    } else {
        document.getElementById('telegram-not-linked')?.classList.remove('hidden');
        document.getElementById('telegram-linked')?.classList.add('hidden');
    }
};
