/**
 * TipsterAI - Utility Functions: Evaluate
 * 
 * Funzioni per la valutazione degli esiti dei pronostici.
 * Usata come fallback quando i dati live hub non sono disponibili.
 */

/**
 * Evaluate a betting tip locally based on final score and status
 * Used as fallback for matches not tracked by API
 * 
 * @param {string} tip - The betting tip
 * @param {string} risultato - The score (e.g., "1-0" or "2-1 (1-0)")
 * @param {boolean} isFinished - True if match is FT
 * @param {string} status - Match status (1H, HT, 2H, FT, etc.)
 * @returns {string|null} - 'Vinto', 'Perso', or null
 */
export function evaluateTipLocally(tip, risultato, isFinished = true, status = 'FT') {
    if (!tip || !risultato) return null;

    // Support "2-1 (1-0)" or "2-1"
    let gH, gA, htH = 0, htA = 0;
    const scoreMatch = risultato.match(/(\d+)\s*[-:]\s*(\d+)(?:\s*\((\d+)\s*[-:]\s*(\d+)\))?/);
    if (!scoreMatch) return null;

    gH = parseInt(scoreMatch[1]);
    gA = parseInt(scoreMatch[2]);
    const total = gH + gA;

    if (scoreMatch[3] !== undefined && scoreMatch[4] !== undefined) {
        htH = parseInt(scoreMatch[3]);
        htA = parseInt(scoreMatch[4]);
    }
    const htTotal = htH + htA;
    const stTotal = total - htTotal;

    const t = String(tip).toLowerCase().trim();
    const stat = (status || 'FT').toUpperCase();

    // --- LOGICA HT / ST SPECIFICA ---
    if (t.includes("05 ht") || t.includes("0.5 ht") || t.includes("over 0.5 ht") || t.includes("+0.5 ht")) {
        // 1. Se abbiamo il parziale HT esplicito
        if (scoreMatch[3] !== undefined) return htTotal >= 1 ? 'Vinto' : (isFinished ? 'Perso' : null);
        // 2. Fallback Live: se c'è un gol e siamo ancora nel 1T o all'intervallo, è VINTO
        if (total >= 1 && (stat === '1H' || stat === 'HT')) return 'Vinto';
        // 3. Se la partita è finita e non abbiamo il parziale, non possiamo essere sicuri al 100% 
        // ma se è 0-0 è sicuramente PERSO.
        if (isFinished && total === 0) return 'Perso';
        return isFinished ? null : null;
    }

    if (t.includes("0.5 st") || t.includes("0.5 second half") || t.includes("+0.5 st")) {
        // 1. Se abbiamo il parziale HT esplicito
        if (scoreMatch[3] !== undefined) return stTotal >= 1 ? 'Vinto' : (isFinished ? 'Perso' : null);
        // 2. Fallback Live: se siamo nel 2T e sono stati fatti gol rispetto a un eventuale stato HT precedente...
        // Difficile senza stato storico, ma se la partita finisce 0-0 è sicuramente PERSO.
        if (isFinished && total === 0) return 'Perso';
        return null;
    }

    // --- TRADING SPECIFICO... (rest of logic remains same) ---

    // --- TRADING SPECIFICO: Pattern esatti valutati PRIMA dei generici ---

    // "Back Under X" = vinci se total < X
    if (t.includes("back under 3.5") || t.includes("lay over 3.5")) {
        if (total >= 4) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }
    if (t.includes("back under 2.5") || t.includes("lay over 2.5")) {
        if (total >= 3) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }
    if (t.includes("back under 1.5") || t.includes("lay over 1.5")) {
        if (total >= 2) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }

    // "Back Over X" = vinci se total >= X
    if (t.includes("back over 2.5") || t.includes("lay under 2.5")) {
        if (total >= 3) return 'Vinto';
        if (total > 0) return 'Cash-out';
        return 'Perso';
    }
    if (t.includes("back over 3.5") || t.includes("lay under 3.5")) {
        if (total >= 4) return 'Vinto';
        if (total > 0) return 'Cash-out';
        return 'Perso';
    }

    // Lay the Draw
    if (t.includes("lay the draw") || t.includes("lay draw") || t.includes("laythedraw")) {
        if (gH !== gA) return 'Vinto';
        if (total >= 2) return 'Cash-out';
        return 'Perso';
    }

    // Over/Under logic (standard)
    const normalizedTip = t.replace(/\s+/g, '');
    if (normalizedTip.includes("+0.5") || normalizedTip.includes("over0.5") || normalizedTip.match(/\bo\s?0\.5/)) return total >= 1 ? 'Vinto' : 'Perso';
    if (normalizedTip.includes("+1.5") || normalizedTip.includes("over1.5") || normalizedTip.match(/\bo\s?1\.5/)) return total >= 2 ? 'Vinto' : 'Perso';
    if (normalizedTip.includes("+2.5") || normalizedTip.includes("over2.5") || normalizedTip.match(/\bo\s?2\.5/)) return total >= 3 ? 'Vinto' : 'Perso';
    if (normalizedTip.includes("+3.5") || normalizedTip.includes("over3.5") || normalizedTip.match(/\bo\s?3\.5/)) return total >= 4 ? 'Vinto' : 'Perso';

    if (normalizedTip.includes("-0.5") || normalizedTip.includes("under0.5") || normalizedTip.match(/\bu\s?0\.5/)) {
        if (total >= 1) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }
    if (normalizedTip.includes("-1.5") || normalizedTip.includes("under1.5") || normalizedTip.match(/\bu\s?1\.5/)) {
        if (total >= 2) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }
    if (normalizedTip.includes("-2.5") || normalizedTip.includes("under2.5") || normalizedTip.match(/\bu\s?2\.5/)) {
        if (total >= 3) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }
    if (normalizedTip.includes("-3.5") || normalizedTip.includes("under3.5") || normalizedTip.match(/\bu\s?3\.5/)) {
        if (total >= 4) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }

    // BTTS / No Goal
    if (t === "gg" || t.includes("btts") || t === "gol" || t === "goal") {
        return (gH > 0 && gA > 0) ? 'Vinto' : 'Perso';
    }
    if (t === "ng" || t === "no gol" || t === "no goal" || t.includes("no goal")) {
        if (gH > 0 && gA > 0) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }

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

// Expose globally for backward compatibility
window.evaluateTipLocally = evaluateTipLocally;
