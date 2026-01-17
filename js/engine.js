console.log('%c[Elite Engine 4.0] Logic Loaded | Professional First Active', 'color: #00ff00; font-weight: bold; background: #000; padding: 5px;');
// ==================== CONFIGURATION & CONSTANTS ====================
// Now using global STRATEGY_CONFIG from js/config.js

const LEAGUE_GOAL_FACTORS = {
    'premier league': 1.12,
    'serie a': 0.92,
    'la liga': 0.98,
    'bundesliga': 1.15,
    'ligue 1': 0.95,
    'eredivisie': 1.25,
    'championship': 0.98,
    'serie b': 0.85,
    'portugal': 0.95,
    'belgian': 1.10,
    'scottish': 1.15,
    'champions league': 1.08,
    'europa league': 1.10,
    'conference league': 1.15
};

/**
 * ENTROPY FACTORS: High entropy = Chaotic/Unpredictable (Eredivisie), 
 * Low entropy = Disciplined/Strategic (Serie A, Serie B).
 * Used to add "jitter" to the Monte Carlo simulation.
 */
const LEAGUE_ENTROPY_FACTORS = {
    'eredivisie': 1.25,
    'bundesliga': 1.15,
    'premier league': 1.10,
    'ligue 1': 1.00,
    'la liga': 0.95,
    'serie a': 0.85,
    'serie b': 0.80,
    'portugal': 1.05,
    'championship': 1.10
};

// DIXON_COLES_RHO and MIN_VALUE_EDGE are now in STRATEGY_CONFIG

/**
 * Calculates the Value Edge between AI probability and Betfair odds
 * @param {number} aiProbability - AI calculated probability (0-100)
 * @param {number} betfairOdds - Betfair decimal odds (e.g., 2.50)
 * @returns {object} { valueEdge, roi, impliedProb, hasProfitableEdge }
 */
function calculateValueEdge(aiProbability, betfairOdds) {
    if (!betfairOdds || betfairOdds <= 1) {
        return { valueEdge: 0, roi: 0, impliedProb: 100, hasProfitableEdge: false };
    }

    const impliedProb = (1 / betfairOdds) * 100;
    const valueEdge = aiProbability - impliedProb;
    const roi = (valueEdge / impliedProb) * 100; // ROI percentage
    const minEdge = (typeof STRATEGY_CONFIG !== 'undefined') ? STRATEGY_CONFIG.TRADING.MIN_VALUE_EDGE : 3;
    const hasProfitableEdge = valueEdge >= minEdge;

    return {
        valueEdge: Math.round(valueEdge * 10) / 10,
        roi: Math.round(roi * 10) / 10,
        impliedProb: Math.round(impliedProb * 10) / 10,
        hasProfitableEdge
    };
}

/**
 * Calculates exponential time weight for a match based on its age.
 * @param {string} matchDateStr - ISO date string of the match
 * @returns {number} weight between 0.1 and 1.0
 */
function calculateTimeWeight(matchDateStr) {
    if (!matchDateStr) return 0.5;
    const matchDate = new Date(matchDateStr);
    const now = new Date();
    const diffDays = Math.max(0, Math.floor((now - matchDate) / (1000 * 60 * 60 * 24)));

    // Decay factor k = 0.0127 ensures weight is ~0.1 after 180 days (6 months)
    const k = 0.0127;
    const weight = Math.exp(-k * diffDays);

    return Math.max(0.1, weight);
}

function normalizeLega(lega) {
    return lega.replace(/\s+/g, ' ').trim();
}

/**
 * Normalizza i nomi delle squadre rimuovendo accenti e caratteri speciali
 * per migliorare il matching tra CSV tip e risultati
 * Gestisce: europei, turchi, polacchi, e altri caratteri speciali
 * Es: "Rrogozhinë" → "Rrogozhine", "Ağrı" → "Agri", "Łódź" → "Lodz"
 */
function normalizeTeamName(name) {
    if (!name) return '';

    // Mappa di sostituzione per caratteri speciali comuni
    const charMap = {
        // Turco
        'ş': 's', 'Ş': 'S',
        'ı': 'i', 'İ': 'I',
        'ğ': 'g', 'Ğ': 'G',
        'ç': 'c', 'Ç': 'C',
        'ö': 'o', 'Ö': 'O',
        'ü': 'u', 'Ü': 'U',
        // Polacco
        'ł': 'l', 'Ł': 'L',
        'ź': 'z', 'Ź': 'Z',
        'ż': 'z', 'Ż': 'Z',
        'ą': 'a', 'Ą': 'A',
        'ę': 'e', 'Ę': 'E',
        'ć': 'c', 'Ć': 'C',
        'ń': 'n', 'Ń': 'N',
        'ó': 'o', 'Ó': 'O',
        'ś': 's', 'Ś': 'S',
        // Altri comuni
        'æ': 'ae', 'Æ': 'AE',
        'œ': 'oe', 'Œ': 'OE',
        'ß': 'ss',
        'ð': 'd', 'Ð': 'D',
        'þ': 'th', 'Þ': 'TH'
    };

    // Sostituisci caratteri speciali
    let normalized = name;
    for (const [char, replacement] of Object.entries(charMap)) {
        normalized = normalized.split(char).join(replacement);
    }

    // NFD decomposition per accenti standard (é, è, ë, etc.)
    normalized = normalized
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, ''); // Remove diacritics

    return normalized.trim();
}

/**
 * Calculates ELO ratings for all teams based on historical matches.
 * Processes matches chronologically to build dynamic strength ratings.
 * @param {Array} allMatchesHistory 
 * @returns {Map} teamName -> rating
 */
function calculateELORatings(allMatchesHistory) {
    if (!allMatchesHistory || allMatchesHistory.length === 0) return new Map();

    const ratings = new Map();
    const K = 32; // Standard sensitivity

    // Filter matches with results and sort chronologically
    const sortedMatches = allMatchesHistory
        .filter(m => m.risultato && m.risultato.includes('-') && m.partita && m.data)
        .sort((a, b) => new Date(a.data) - new Date(b.data));

    console.log(`[ELO Engine] Calculating ratings from ${sortedMatches.length} matches...`);

    sortedMatches.forEach(match => {
        const teams = match.partita.split(' - ');
        if (teams.length !== 2) return;

        const home = teams[0].trim();
        const away = teams[1].trim();

        const res = match.risultato.match(/(\d+)\s*-\s*(\d+)/);
        if (!res) return;

        const hg = parseInt(res[1]);
        const ag = parseInt(res[2]);

        const rH = ratings.get(home) || 1500;
        const rA = ratings.get(away) || 1500;

        // Expected outcome
        const expectedH = 1 / (1 + Math.pow(10, (rA - rH) / 400));
        const expectedA = 1 - expectedH;

        // Actual outcome
        let scoreH = 0.5;
        if (hg > ag) scoreH = 1;
        else if (ag > hg) scoreH = 0;
        const scoreA = 1 - scoreH;

        // Update ratings
        ratings.set(home, rH + K * (scoreH - expectedH));
        ratings.set(away, rA + K * (scoreA - expectedA));
    });

    console.log(`[ELO Engine] Ratings calculated for ${ratings.size} teams.`);
    return ratings;
}


// ==================== STATISTICAL ANALYSIS ====================

function analyzeLeaguePerformance(dbCompleto) {
    if (!dbCompleto || dbCompleto.length === 0) return {};

    const leagueStats = {};

    dbCompleto.forEach(match => {
        const lega = (match.lega || '').toLowerCase().trim();
        if (!lega) return;

        if (!leagueStats[lega]) {
            leagueStats[lega] = {
                totalMatches: 0,
                over25Count: 0,
                under25Count: 0,
                tips: {}
            };
        }

        leagueStats[lega].totalMatches++;

        const risultato = match.risultato || '';
        const golMatch = risultato.match(/(\d+)\s*-\s*(\d+)/);

        let golTotali = 0;
        if (golMatch) {
            const golCasa = parseInt(golMatch[1]);
            const golTrasferta = parseInt(golMatch[2]);
            golTotali = golCasa + golTrasferta;

            if (golTotali > 2.5) leagueStats[lega].over25Count++;
            else leagueStats[lega].under25Count++;
        }

        const tip = (match.tip || '').trim();
        if (tip) {
            if (!leagueStats[lega].tips[tip]) {
                leagueStats[lega].tips[tip] = { total: 0, success: 0 };
            }

            leagueStats[lega].tips[tip].total++;

            let success = false;
            if (golMatch && golTotali > 0) {
                if (tip.startsWith('+')) {
                    const soglia = parseFloat(tip.substring(1));
                    success = golTotali > soglia;
                } else if (tip.startsWith('-')) {
                    const soglia = parseFloat(tip.substring(1));
                    success = golTotali < soglia;
                }
            }

            if (success) leagueStats[lega].tips[tip].success++;
        }
    });

    Object.keys(leagueStats).forEach(lega => {
        const stats = leagueStats[lega];
        stats.over25Percentage = (stats.over25Count / stats.totalMatches * 100).toFixed(0);
        stats.under25Percentage = (stats.under25Count / stats.totalMatches * 100).toFixed(0);

        Object.keys(stats.tips).forEach(tip => {
            const tipStats = stats.tips[tip];
            tipStats.successRate = (tipStats.success / tipStats.total * 100).toFixed(0);
        });
    });

    return leagueStats;
}

function analyzeTeamStats(teamName, isHome, tip, dbCompleto) {
    if (!dbCompleto || dbCompleto.length === 0) {
        return { color: 'black', stats: '', count: 0, total: 0, percentage: 0, penalty: 0, scoreValue: 0, details: '', season: { avgScored: 1.5, avgConceded: 1.0 }, currForm: { avgScored: 1.5, avgConceded: 1.0, matchCount: 0 } };
    }

    const teamNorm = teamName.toLowerCase().trim();

    // v3.5.0 NUOVA LOGICA: Calcolo preciso score + penalità
    const isOverUnder = tip.startsWith('+') || tip.startsWith('-');

    let relevantMatches = [];

    // Filtra match ultimi 6 mesi con risultato
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const matchFilter = row => {
        if (!row.risultato || row.risultato.trim() === '') return false;
        const matchDate = new Date(row.data || '2000-01-01');
        // If 'ALL' tip (for Monte Carlo), take all history, otherwise filter by date if needed
        if (tip !== 'ALL' && matchDate < sixMonthsAgo) return false;

        const team1 = (row.partita || '').split(' - ')[0]?.toLowerCase().trim() || '';
        const team2 = (row.partita || '').split(' - ').slice(1).join(' - ')?.toLowerCase().trim() || '';
        return (team1 === teamNorm || team2 === teamNorm);
    };

    const allTeamMatches = dbCompleto.filter(matchFilter);
    allTeamMatches.sort((a, b) => new Date(b.data || '2000-01-01') - new Date(a.data || '2000-01-01'));

    // Calc Goals Stats (Season Average with Time Decay)
    let weightedScored = 0;
    let weightedConceded = 0;
    let totalWeight = 0;

    allTeamMatches.forEach(m => {
        const team1 = (m.partita || '').split(' - ')[0]?.toLowerCase().trim() || '';
        const isTeamHome = team1 === teamNorm;
        const res = m.risultato.match(/(\d+)-(\d+)/);
        if (res) {
            const hg = parseInt(res[1]);
            const ag = parseInt(res[2]);
            const weight = calculateTimeWeight(m.data);

            weightedScored += (isTeamHome ? hg : ag) * weight;
            weightedConceded += (isTeamHome ? ag : hg) * weight;
            totalWeight += weight;
        }
    });

    const seasonStats = {
        avgScored: totalWeight > 0 ? weightedScored / totalWeight : 1.3,
        avgConceded: totalWeight > 0 ? weightedConceded / totalWeight : 1.2,
        matches: allTeamMatches.length,
        totalWeight: totalWeight
    };

    if (tip === 'ALL') {
        // Return rich stats strictly for Monte Carlo
        // Current Form (Last 5 - Still using simple average for form, but decay for season)
        const recent = allTeamMatches.slice(0, 5);
        let recScored = 0, recConceded = 0;
        recent.forEach(m => {
            const team1 = (m.partita || '').split(' - ')[0]?.toLowerCase().trim() || '';
            const isTeamHome = team1 === teamNorm;
            const res = m.risultato.match(/(\d+)-(\d+)/);
            if (res) {
                const hg = parseInt(res[1]);
                const ag = parseInt(res[2]);
                recScored += isTeamHome ? hg : ag;
                recConceded += isTeamHome ? ag : hg;
            }
        });

        const currForm = {
            avgScored: recent.length ? recScored / recent.length : seasonStats.avgScored,
            avgConceded: recent.length ? recConceded / recent.length : seasonStats.avgConceded,
            matchCount: recent.length
        };

        return { season: seasonStats, currForm: currForm };
    }


    if (isOverUnder) {
        // OVER/UNDER: Tutti i match della squadra (ultimi 9)
        relevantMatches = allTeamMatches.slice(0, 9);
    } else {
        // 1X2/DC: Match casa o trasferta (ultimi 5)
        let locationMatches = allTeamMatches.filter(row => {
            const team1 = (row.partita || '').split(' - ')[0]?.toLowerCase().trim() || '';
            const team2 = (row.partita || '').split(' - ').slice(1).join(' - ')?.toLowerCase().trim() || '';
            if (isHome) return team1 === teamNorm;
            else return team2 === teamNorm;
        });
        relevantMatches = locationMatches.slice(0, 5); // Solo ultimi 5 per 1X2/DC
    }

    // Minimo match richiesti
    const minMatches = isOverUnder ? 5 : 3;
    if (relevantMatches.length < minMatches) {
        return {
            color: 'gray',
            stats: `(${relevantMatches.length})`,
            count: 0,
            total: relevantMatches.length,
            percentage: 0,
            penalty: 0,
            scoreValue: 0,
            details: `Dati insufficienti (min ${minMatches})`
        };
    }

    let successCount = 0;
    let penalty = 0;
    let detailsArray = [];

    relevantMatches.forEach(match => {
        const risultato = match.risultato || '';
        const golMatch = risultato.match(/(\d+)\s*-\s*(\d+)/);

        if (!golMatch) return;

        const golCasa = parseInt(golMatch[1]);
        const golTrasferta = parseInt(golMatch[2]);
        const golTotali = golCasa + golTrasferta;

        const team1 = (match.partita || '').split(' - ')[0]?.toLowerCase().trim() || '';
        const isTeamHome = team1 === teamNorm;

        let success = false;

        if (tip.startsWith('+')) {
            // OVER: conta gol totali > soglia
            const soglia = parseFloat(tip.substring(1));
            success = golTotali > soglia;

            // Penalità -5 per ogni 0-0
            if (golCasa === 0 && golTrasferta === 0) {
                penalty += 5;
                detailsArray.push(`0-0 (-5 pen)`);
            }

        } else if (tip.startsWith('-')) {
            // UNDER: conta gol totali < soglia
            const soglia = parseFloat(tip.substring(1));
            success = golTotali < soglia;

            // Penalità -5 per ogni 4+ gol (se Under 3.5)
            if (soglia <= 3.5 && golTotali >= 4) {
                penalty += 5;
                detailsArray.push(`${golCasa}-${golTrasferta} 4+ gol (-5 pen)`);
            }

        } else if (tip === '1') {
            // Casa vince (Tip 1)
            if (isHome && isTeamHome) {
                // Casa FAVORITA: conta vittorie
                success = golCasa > golTrasferta;
            } else if (!isHome && !isTeamHome) {
                // Trasferta SFAVORITA: conta sconfitte
                success = golTrasferta < golCasa;
            }

        } else if (tip === 'X') {
            // Pareggio (Tip X)
            // Entrambe contano pareggi
            success = golCasa === golTrasferta;

        } else if (tip === '2') {
            // Trasferta vince (Tip 2)
            if (!isHome && !isTeamHome) {
                // Trasferta FAVORITA: conta vittorie
                success = golTrasferta > golCasa;
            } else if (isHome && isTeamHome) {
                // Casa SFAVORITA: conta sconfitte
                success = golCasa < golTrasferta;
            }

        } else if (tip === '1X') {
            // Casa o Pareggio (Tip 1X)
            if (isHome && isTeamHome) {
                // Casa FAVORITA: conta non-sconfitte (V+P)
                success = golCasa >= golTrasferta;
            } else if (!isHome && !isTeamHome) {
                // Trasferta SFAVORITA: conta sconfitte + pareggi (NON vittorie)
                // Logica: vogliamo che NON vinca
                success = golTrasferta <= golCasa;
            }

        } else if (tip === '12') {
            // Casa o Trasferta (no pareggio) (Tip 12)
            // Entrambe contano SOLO vittorie
            const isVittoria = (isHome && isTeamHome && golCasa > golTrasferta) ||
                (!isHome && !isTeamHome && golTrasferta > golCasa);
            success = isVittoria;

            // Penalità -5 per ogni pareggio
            if (golCasa === golTrasferta) {
                penalty += 5;
                detailsArray.push(`${golCasa}-${golTrasferta} pareggio (-5 pen)`);
            }

        } else if (tip === 'X2') {
            // Pareggio o Trasferta (Tip X2)
            if (!isHome && !isTeamHome) {
                // Trasferta FAVORITA: conta non-sconfitte (V+P)
                success = golTrasferta >= golCasa;
            } else if (isHome && isTeamHome) {
                // Casa SFAVORITA: conta sconfitte + pareggi (NON vittorie)
                // Logica: vogliamo che NON vinca
                success = golCasa <= golTrasferta;
            }
        }

        if (success) successCount++;
    });

    // Calcola percentuale ESATTA
    const percentage = relevantMatches.length > 0 ? (successCount / relevantMatches.length) * 100 : 0;

    // Score value = percentuale - penalità
    const scoreValue = Math.max(0, Math.round(percentage - penalty));

    // Colore basato su score finale
    let color = 'black';
    if (relevantMatches.length >= minMatches) {
        if (scoreValue >= 70) color = 'green';
        else if (scoreValue >= 50) color = 'yellow';
        else color = 'red';
    }

    // Details string
    const details = detailsArray.length > 0 ? detailsArray.join(', ') : '';

    return {
        color: color,
        stats: `(${successCount}/${relevantMatches.length})`,
        count: successCount,
        total: relevantMatches.length,
        percentage: Math.round(percentage),
        penalty: penalty,
        scoreValue: scoreValue,
        details: details
    };
}

// Analizza tasso pareggi storico per una squadra
function analyzeDrawRate(teamName, allMatches) {
    if (!teamName || !allMatches) return { rate: 0, total: 0, draws: 0 };

    const teamLower = teamName.toLowerCase().trim();

    // Trova partite storiche della squadra (ultimi 30 match con risultato)
    const matchesSquadra = allMatches.filter(m => {
        if (!m.risultato || m.risultato.trim() === '') return false;
        const partitaLower = (m.partita || '').toLowerCase();
        return partitaLower.includes(teamLower);
    }).slice(0, 30); // Max 30 match

    if (matchesSquadra.length === 0) return { rate: 0, total: 0, draws: 0 };

    // Conta pareggi
    const pareggi = matchesSquadra.filter(m => {
        const ris = m.risultato.split('-').map(n => parseInt(n.trim()));
        if (ris.length !== 2 || isNaN(ris[0]) || isNaN(ris[1])) return false;
        return ris[0] === ris[1]; // Es. "1-1", "0-0", "2-2"
    });

    const rate = (pareggi.length / matchesSquadra.length) * 100;

    return {
        rate: Math.round(rate),
        total: matchesSquadra.length,
        draws: pareggi.length
    };
}


// ==================== SCORING ALGORITHMS ====================

function calculateScore05HT(partita, dbCompleto) {
    let score = 0;

    // Estrai HT prob
    let htProb = 0;
    if (partita.info_ht && partita.info_ht.trim() !== '') {
        const htMatch = partita.info_ht.match(/(\d+)%/);
        if (htMatch) htProb = parseInt(htMatch[1]);
    }

    // PESO 1: HT Probability (50% del score)
    if (htProb >= 85) score += 50;
    else if (htProb >= 80) score += 45;
    else if (htProb >= 75) score += 40;
    else if (htProb >= 70) score += 35;
    else if (htProb >= 65) score += 25;

    // PESO 2: Prolificità squadre Over 1.5 (30% del score)
    const teams = partita.partita.split(' - ');
    if (teams.length === 2 && dbCompleto && dbCompleto.length > 0) {
        const teamHome = teams[0].trim();
        const teamAway = teams[1].trim();

        const homeStats = analyzeTeamStats(teamHome, true, '+1.5', dbCompleto);
        const awayStats = analyzeTeamStats(teamAway, false, '+1.5', dbCompleto);

        if (homeStats.total >= 5 && awayStats.total >= 5) {
            const homePerc = (homeStats.count / homeStats.total) * 100;
            const awayPerc = (awayStats.count / awayStats.total) * 100;
            const avgPerc = (homePerc + awayPerc) / 2;

            if (avgPerc >= 75) score += 30;
            else if (avgPerc >= 65) score += 25;
            else if (avgPerc >= 55) score += 20;
            else if (avgPerc >= 45) score += 15;
            else score += 10;
        }
    }

    // PESO 3: Orario favorevole (20% del score - bonus)
    if (partita.time) {
        const [hours] = partita.time.split(':').map(Number);
        if (hours >= 17 && hours <= 22) score += 20; // Orario prime time
        else if (hours >= 14 && hours <= 23) score += 10; // Orario buono
    }

    return {
        teamBonus: score,
        totalScore: Math.min(100, score),
        quotaValid: true,
    };
}

/**
 * Crea una strategia Lay The Draw (LTD) professionale
 * @param {object} match - Dati della partita
 * @param {number} avgDrawRate - Tasso pareggi medio (storico)
 * @param {object} homeDrawRate - Dettagli pareggi casa
 * @param {object} awayDrawRate - Dettagli pareggi trasferta
 * @param {boolean} isConvergent - Se AI e Storico concordano (Diamond Signal)
 */
function createLayTheDrawStrategy(match, avgDrawRate, homeDrawRate, awayDrawRate, isConvergent = false) {
    // ==================== LIQUIDITY CHECK ====================
    // Liquidity check removed as per user request
    // =========================================================

    const prob = match.probabilita;
    const tip = match.tip;

    // Range ingresso: 2.50 - 4.50 (allargato per maggiore copertura)
    const entryRange = ['2.50', '4.50'];

    // ANALISI DETTAGLIATA PER REASONING
    let reasoning = [];

    // Base: segno probabile
    const tipLabel = tip === '1' ? `vittoria ${match.partita.split(' - ')[0]}` :
        tip === '2' ? `vittoria ${match.partita.split(' - ')[1]}` :
            'segno (no pareggio)';

    if (isConvergent) {
        reasoning.push(`🔥 <strong>DIAMOND SIGNAL</strong>: Convergenza AI + Storico Squadre`);
    } else {
        reasoning.push(`Alta probabilità ${tipLabel} (${prob}%)`);
    }

    // Analisi dettagliata pareggi
    if (avgDrawRate <= 15) {
        reasoning.push(`squadre che pareggiano raramente (solo ${avgDrawRate.toFixed(0)}% dei match)`);
    } else if (avgDrawRate <= 22) {
        reasoning.push(`basso tasso pareggi storico (${avgDrawRate.toFixed(0)}%)`);
    }

    // Info lega se rilevante
    const legaNorm = normalizeLega(match.lega).toLowerCase();
    if (legaNorm.includes('premier') || legaNorm.includes('bundesliga') || legaNorm.includes('serie a')) {
        reasoning.push('top campionato con pochi pareggi tattici');
    }

    return {
        ...match,
        _originalTip: match.tip,
        _originalQuota: match.quota,
        strategy: 'LAY_THE_DRAW',
        tradingInstruction: {
            action: 'Lay The Draw',
            entry: {
                range: [parseFloat(entryRange[0]), parseFloat(entryRange[1])],
                timing: 'Primi 10-15 min'
            },
            exit: {
                target: 1.60,
                timing: 'Dopo 1° gol (Cash-out)'
            },
            stopLoss: {
                trigger: 2.00,
                timing: 'Se 0-0 al 65-70 min'
            }
        },
        // CONFIDENCE basato su probabilità reale per ranking equilibrato
        confidence: Math.min(95, (match.probabilita || 70) + (isConvergent ? 10 : 5)),
        reasoning: reasoning.join(' + '),
        badge: {
            text: 'Trading Lay The Draw',
            color: 'bg-blue-100 text-blue-700 border-blue-300'
        }
    };
}

function calculateScore(partita, legheSet, tipsSet, leaguePerformance = {}, dbCompleto = null) {
    // v3.5.0 - SCORE DA SCOREVALUE: usa direttamente score calcolato da analyzeTeamStats

    let score = 0;
    const tipNorm = (partita.tip || '').trim().toUpperCase();
    const mercato = (partita.mercato || '').toLowerCase().trim();

    // Se non ho DB, score 0
    if (!dbCompleto || dbCompleto.length === 0 || !partita.partita) {
        return {
            teamBonus: 0,
            totalScore: 0,
            quotaValid: true
        };
    }

    const teams = partita.partita.split(' - ');
    if (teams.length !== 2) {
        return {
            teamBonus: 0,
            totalScore: 0,
            quotaValid: true
        };
    }

    const teamHome = teams[0].trim();
    const teamAway = teams[1].trim();

    // Analizza statistiche squadre
    const homeStats = analyzeTeamStats(teamHome, true, tipNorm, dbCompleto);
    const awayStats = analyzeTeamStats(teamAway, false, tipNorm, dbCompleto);

    // ========== OVER/UNDER (+1.5, +2.5, -2.5, etc) ==========
    if (tipNorm.startsWith('+') || tipNorm.startsWith('-')) {
        // Usa scoreValue DIRETTO da analyzeTeamStats
        // Media dei due score
        const avgScore = (homeStats.scoreValue + awayStats.scoreValue) / 2;
        score = Math.round(avgScore);

        // BOOST HT se disponibile (solo per OVER)
        if (tipNorm.startsWith('+') && partita.info_ht && partita.info_ht.trim() !== '') {
            const probMatch = partita.info_ht.match(/(\d+)%/);
            if (probMatch) {
                const htProb = parseInt(probMatch[1]);
                if (htProb >= 75) score += 15;
                else if (htProb >= 65) score += 10;
                else if (htProb >= 55) score += 5;
            }
        }

        // PENALITÀ HT alto (solo per UNDER)
        if (tipNorm.startsWith('-') && partita.info_ht && partita.info_ht.trim() !== '') {
            const probMatch = partita.info_ht.match(/(\d+)%/);
            if (probMatch) {
                const htProb = parseInt(probMatch[1]);
                if (htProb >= 75) score -= 15;
                else if (htProb >= 65) score -= 10;
            }
        }

        return {
            teamBonus: score,
            totalScore: Math.max(0, Math.min(100, score)),
            quotaValid: true
        };
    }

    // ========== 1X2 / Doppia Chance ==========
    // Usa scoreValue DIRETTO da analyzeTeamStats
    const avgScore = (homeStats.scoreValue + awayStats.scoreValue) / 2;
    score = Math.round(avgScore);

    return {
        teamBonus: score,
        totalScore: Math.max(0, Math.min(100, score)),
        quotaValid: true
    };
}


// ==================== TRADING STRATEGIES ====================

// Estrai probabilità HT da info_ht
function extractHTProb(info_ht) {
    if (!info_ht || info_ht.trim() === '') return 0;
    const htMatch = info_ht.match(/(\d+)%/);
    return htMatch ? parseInt(htMatch[1]) : 0;
}

// ═══════════════════════════════════════════════════════════════════════
// 🧠 TRADING STRATEGIES 3.0
// ═══════════════════════════════════════════════════════════════════════

function createBackOver25Strategy(match, htProb, allMatches) {
    // La liquidità è già filtrata a monte in admin.html dalla "Lista Sacra"

    const prob = match.probabilita;
    const quota = match.quota;

    // Stima quota Over 2.5 con Poisson semplificato
    const probOver25Estimated = (prob >= 80) ? prob * 0.70 : prob * 0.65;
    const quotaOver25Suggested = 1 / (probOver25Estimated / 100);

    // Range trading: ±12% dalla quota centrale
    const entryRange = [
        (quotaOver25Suggested * 0.88).toFixed(2),
        (quotaOver25Suggested * 1.12).toFixed(2)
    ];

    // ANALISI DETTAGLIATA PER REASONING
    const teams = match.partita.split(' - ');
    let reasoning = [];

    // Base: probabilità originale
    if (match.tip === '+1.5') {
        reasoning.push(`Over 1.5 molto probabile (${prob}%)`);
    } else {
        reasoning.push(`Over 2.5 probabile (${prob}%)`);
    }

    // Analisi HT se disponibile
    if (htProb >= 85) {
        reasoning.push(`gol quasi certo nel 1°T (${htProb}%) - OTTIMO per trading live`);
    } else if (htProb >= 75) {
        reasoning.push(`alta probabilità gol 1°T (${htProb}%)`);
    } else if (htProb >= 65) {
        reasoning.push(`buona prob gol 1°T (${htProb}%)`);
    }

    return {
        ...match,
        _originalTip: match.tip || 'N/A',
        _originalQuota: match.quota || 'N/A',
        strategy: 'BACK_OVER_25',
        tradingInstruction: {
            action: 'Back Over 2.5',
            entryRange: ['@1.80-2.30 (Live)'],
            exitTarget: '60 min / 1 Gol',
            timing: 'Pre-match / Live',
            entry: {
                range: [1.80, 2.30],
                timing: 'Primi 15-20 min'
            },
            exit: {
                target: 1.15,
                timing: 'Dopo 1° gol (Cash-out)'
            },
            stopLoss: {
                trigger: 1.20,
                timing: 'Se 0-0 al 70 min'
            }
        },
        confidence: forcedConfidence || Math.min(95, Math.max(prob, match.score || 0)),
        reasoning: reasoning.length > 0 ? reasoning.join(' + ') : `Analisi Over 2.5 (${prob}%)`,
        badge: {
            text: 'Trading Back Over 2.5',
            color: 'bg-indigo-600 text-white border-indigo-700 shadow-sm'
        }
    };
}

// Helper: Crea strategia HT SNIPER (0.5 HT Live)
function createHTSniperStrategy(match, htProb, forcedConfidence = null) {
    return {
        ...match,
        _originalTip: match.tip || 'N/A',
        _originalQuota: match.quota || 'N/A',
        strategy: 'HT_SNIPER',
        tradingInstruction: {
            action: 'Back Over 0.5 HT',
            entry: {
                range: [1.50, 2.00],
                timing: 'Minuto 15-20'
            },
            exit: {
                target: 1.10,
                timing: 'Dopo gol 1°T (Cash-out)'
            },
            stopLoss: {
                trigger: 1.01,
                timing: 'Fine 1° Tempo'
            }
        },
        confidence: forcedConfidence || Math.min(95, htProb),
        reasoning: `ALTA PROBABILITÀ GOL 1°T (${htProb}%). Se 0-0 al minuto 20, la quota diventa di estremo valore.`,
        badge: {
            text: '🎯 HT SNIPER',
            color: 'bg-red-600 text-white border-red-700 shadow-sm animate-pulse'
        }
    };
}

// Helper: Crea strategia SECOND HALF SURGE (0.5 ST)
function createSecondHalfSurgeStrategy(match, allMatches, forcedConfidence = null) {
    const prob = match.magicStats?.prob || match.probabilita || 65;
    return {
        ...match,
        _originalTip: match.tip || 'N/A',
        _originalQuota: match.quota || 'N/A',
        strategy: 'SECOND_HALF_SURGE',
        tradingInstruction: {
            action: 'Back Over 0.5 ST',
            entry: {
                range: [1.60, 2.00],
                timing: 'Minuto 55-65'
            },
            exit: {
                target: 1.10,
                timing: 'Dopo gol 2°T (Cash-out)'
            },
            stopLoss: {
                trigger: 1.01,
                timing: 'Minuto 85'
            }
        },
        confidence: forcedConfidence || Math.min(95, prob),
        reasoning: `Match ad alta intensità statistica. Ottimo per sfruttare il calo delle quote nel secondo tempo tra il minuto 60 e 80.`,
        badge: {
            text: '🔥 SEC HALF SURGE',
            color: 'bg-orange-600 text-white border-orange-700 shadow-sm'
        }
    };
}

// Helper: Crea strategia LAY THE DRAW
function createLayTheDrawStrategy(match, avgHistDraw, homeDrawRate, awayDrawRate, isHighProb = false, forcedConfidence = null) {
    const mcDrawProb = match.magicStats?.drawProb || match.magicStats?.draw || 30;
    return {
        ...match,
        _originalTip: match.tip || 'N/A',
        _originalQuota: match.quota || 'N/A',
        strategy: 'LAY_THE_DRAW',
        tradingInstruction: {
            action: 'Lay The Draw',
            entry: {
                range: [3.40, 4.50],
                timing: 'Live @ 15-20 min'
            },
            exit: {
                target: 2.00,
                timing: 'Dopo gol favorito'
            },
            stopLoss: {
                trigger: 2.00,
                timing: 'Se 0-0 al 70 min'
            }
        },
        confidence: forcedConfidence || Math.min(95, 100 - mcDrawProb),
        reasoning: `Alta probabilità segno (no pareggio) (${Math.round(100 - mcDrawProb)}%) + basso tasso pareggi storico (${avgHistDraw.toFixed(0)}%) + top campionato con pochi pareggi.`,
        badge: {
            text: '🎲 LAY THE DRAW',
            color: 'bg-blue-600 text-white border-blue-700 shadow-sm'
        }
    };
}

function createBackOver25Strategy(match, htProb, allMatches, forcedConfidence = null) {
    const magicData = match.magicStats;
    const prob = magicData?.over25 || magicData?.over25Prob || 0;

    const reasoning = [];
    if (prob >= 60) reasoning.push(`Over 2.5 molto probabile (${prob}%)`);
    if (htProb >= 70) reasoning.push(`alta probabilità gol 1°T (${htProb}%)`);

    const teams = match.partita.split(' - ');
    if (teams.length === 2) {
        const league = window.normalizeLega(match.lega).toLowerCase();
        const highGoalLeagues = ['premier', 'eredivisie', 'bundesliga', 'championship', 'belgio', 'islanda'];
        if (highGoalLeagues.some(l => league.includes(l))) {
            reasoning.push('campionato ad alto tasso gol');
        }
    }

    return {
        ...match,
        _originalTip: match.tip || 'N/A',
        _originalQuota: match.quota || 'N/A',
        strategy: 'BACK_OVER_25',
        tradingInstruction: {
            action: 'Back Over 2.5',
            entryRange: ['@1.80-2.30 (Live)'],
            exitTarget: '60 min / 1 Gol',
            timing: 'Pre-match / Live',
            entry: {
                range: [1.80, 2.30],
                timing: 'Primi 15-20 min'
            },
            exit: {
                target: 1.15,
                timing: 'Dopo 1° gol (Cash-out)'
            },
            stopLoss: {
                trigger: 1.20,
                timing: 'Se 0-0 al 70 min'
            }
        },
        confidence: forcedConfidence || Math.min(95, Math.max(prob, match.score || 0)),
        reasoning: reasoning.length > 0 ? reasoning.join(' + ') : `Analisi Over 2.5 (${prob}%)`,
        badge: {
            text: 'Trading Back Over 2.5',
            color: 'bg-indigo-600 text-white border-indigo-700 shadow-sm'
        }
    };
}

// Helper: Crea strategia UNDER 3.5 TRADING (Scalping)
function createUnder35TradingStrategy(match, forcedConfidence = null) {
    return {
        ...match,
        _originalTip: match.tip || 'N/A',
        _originalQuota: match.quota || 'N/A',
        strategy: 'UNDER_35_SCALPING',
        tradingInstruction: {
            action: 'Under 3.5 Scalping',
            entry: {
                range: [1.30, 1.60],
                timing: 'Live (Primi 5-10 min)'
            },
            exit: {
                target: 1.15,
                timing: 'Dopo 15-20 min senza gol'
            },
            stopLoss: {
                trigger: 2.50,
                timing: 'Dopo il 1° gol subito'
            }
        },
        confidence: forcedConfidence || Math.min(95, match.probabilita || 70),
        reasoning: `Sistema difensivo solido rilevato. Scalping Under 3.5 con uscita programmata o stop loss a fine primo tempo.`,
        badge: {
            text: '🛡️ UNDER SCALPING',
            color: 'bg-emerald-600 text-white border-emerald-700 shadow-sm'
        }
    };
}

// Funzione principale: Trasforma partita in strategia trading
// TRADING 3.0: Puro calcolo statistico + VALUE EDGE con odds Betfair
// @param {object} match - Match data including betfairOdds if available
// @param {array} allMatches - Historical matches for stats calculation
function transformToTradingStrategy(match, allMatches) {
    const prob = match.probabilita || 0;
    const htProb = extractHTProb(match.info_ht);
    const magicData = match.magicStats;
    const score = magicData?.score || match.score || 0;

    // Extract Betfair odds from match (passed from admin after API fetch)
    const betfairOdds = {
        over25: parseFloat(match.betfairOver25) || null,
        under25: parseFloat(match.betfairUnder25) || null,
        draw: parseFloat(match.quotaX) || parseFloat(match.betfairDraw) || null,
        home: parseFloat(match.quota1) || null,
        away: parseFloat(match.quota2) || null,
        gg: parseFloat(match.betfairGG) || null,
        ng: parseFloat(match.betfairNG) || null
    };

    // ════════════════════════════════════════════════════════════════
    // TRADING 3.0 + VALUE EDGE: Calcola strategie CON verifica valore
    // PRIORITÀ: OVER 2.5 > SECOND HALF > LTD > UNDER 3.5 > HT SNIPER (fallback)
    // ════════════════════════════════════════════════════════════════

    // DEBUG: Log magicData and Betfair odds
    if (!magicData || Object.keys(magicData).length === 0) {
        console.warn(`[Trading 3.0] ⚠️ magicData ASSENTE per ${match.partita}`);
    }

    // 🔍 DEBUG: Mostra valori usati per la selezione + ODDS BETFAIR
    console.log(`[Trading 3.0 DEBUG] === ${match.partita} ===`);
    console.log(`  📊 score: ${score}, prob: ${prob}, htProb: ${htProb}`);
    console.log(`  🎲 magicData:`, magicData ? JSON.stringify({
        over25Prob: magicData.over25Prob,
        htGoalProb: magicData.htGoalProb,
        drawProb: magicData.drawProb
    }) : 'NULL');
    console.log(`  💰 Betfair Odds:`, JSON.stringify(betfairOdds));

    // 🔍 ANALISI ELITE (ELO & MOTIVAZIONE)
    const eloDiff = magicData?.eloDiff || 0;
    const badges = magicData?.motivationBadges || [];
    const hasMotivation = badges.length > 0;
    const isDirectClash = badges.includes('⚔️ Scontro Diretto');
    const isTitleRace = badges.includes('🏆 Corsa Titolo');
    const isRelegationFight = badges.includes('🆘 Lotta Salvezza');

    const strategies = [];

    // ─── STRATEGIA 1: BACK OVER 2.5 ───
    const over25Prob = magicData?.over25 ? magicData.over25 : (magicData?.over25Prob || 0);
    const cfgOver25 = STRATEGY_CONFIG.TRADING.STRATEGIES.BACK_OVER_25;

    const over25Edge = betfairOdds.over25
        ? calculateValueEdge(over25Prob, betfairOdds.over25)
        : { valueEdge: 0, hasProfitableEdge: true };

    let over25Confidence = Math.round(over25Prob + (over25Prob >= 50 ? 15 : 10));

    if (hasMotivation) over25Confidence += 5;
    if (Math.abs(eloDiff) > 200) over25Confidence += 5;

    // RELAX ELITE: Se abbiamo motivazione forte o ELO gap, accettiamo anche edge marginali (fino a -5%)
    const minEdgeAllowed = (hasMotivation || Math.abs(eloDiff) > 200) ? -5 : 0;
    const over25Passes = over25Prob >= (cfgOver25.minProb || 40) &&
        over25Confidence >= (cfgOver25.minConfidence || 50) &&
        (over25Edge.valueEdge >= minEdgeAllowed);

    if (over25Passes) {
        // PRIORITÀ ELITE: +15 Bonus per strategie Professionali (v2)
        const finalConfidence = Math.min(98, over25Confidence + 15);
        strategies.push({
            type: 'BACK_OVER_25',
            confidence: finalConfidence,
            data: { over25Prob, prob, valueEdge: over25Edge.valueEdge, badges, eloDiff },
            create: () => {
                const s = createBackOver25Strategy(match, htProb, allMatches, finalConfidence);
                s.reasoning = `Analisi Magia AI (${over25Prob}%). ` +
                    (hasMotivation ? `Focus su motivazione speciale (${badges.join(', ')}). ` : '') +
                    (Math.abs(eloDiff) > 150 ? `Gap tecnico ELO significativo (${eloDiff}).` : '');
                return s;
            }
        });
    }

    // ─── STRATEGIA 5: HT SNIPER (Elite Refined) ───
    const htGoalProb = magicData?.htGoalProb || htProb;
    // REQUISITI ELITE: Probabilità più alta (72%) OPPURE 65% + Motivazione
    const htSniperPasses = (htProb >= 72 || (htProb >= 65 && hasMotivation));

    const htSniperCandidate = htSniperPasses ? {
        type: 'HT_SNIPER',
        // SUPPRESSION ELITE v2: -25 Penalità per HT Sniper if professional alternative exists
        confidence: Math.min(95, Math.round(Math.max(htProb, htGoalProb)) + (isTitleRace ? 5 : 0)) - 25,
        data: { htProb, htGoalProb, badges },
        create: (overrideConf) => {
            const finalConf = overrideConf || (Math.min(95, Math.round(Math.max(htProb, htGoalProb)) + (isTitleRace ? 5 : 0)) - 25);
            const s = createHTSniperStrategy(match, htProb, finalConf);
            s.reasoning = `Focus Over 0.5 HT (${htProb}%). ` +
                (hasMotivation ? `Spinta da obiettivi classifica: ${badges.join(', ')}.` : 'Match con alta intensità iniziale prevista.');
            return s;
        }
    } : null;

    // ─── STRATEGIA 3: LAY THE DRAW (REVISED WITH BETFAIR ODDS) ───
    // LTD funziona quando:
    // 1. AI pensa che il pareggio sia possibile ma NON probabile (25-38%)
    // 2. Betfair quota il pareggio ALTO (@3.40+) = c'è margine per il lay
    const teams = match.partita.split(' - ');
    if (teams.length === 2) {
        const homeDrawRate = analyzeDrawRate(teams[0].trim(), allMatches);
        const awayDrawRate = analyzeDrawRate(teams[1].trim(), allMatches);
        const avgHistDraw = (homeDrawRate.rate + awayDrawRate.rate) / 2;
        const mcDrawProb = magicData?.drawProb || magicData?.draw || 30;
        const drawOdds = betfairOdds.draw || 3.50;

        // NUOVA LOGICA ELITE: LTD è meno affidabile negli scontri diretti "biscotto"
        const isBiscottoRisk = isDirectClash && mcDrawProb > 33;
        const ltdDrawProbOk = mcDrawProb >= 22 && mcDrawProb <= 38 && !isBiscottoRisk;
        const ltdOddsOk = drawOdds >= 3.40;
        const ltdHistOk = avgHistDraw < 35;
        const ltdPasses = ltdDrawProbOk && ltdOddsOk && ltdHistOk;

        if (ltdPasses) {
            const oddsBonus = Math.min(15, (drawOdds - 3.0) * 5);
            // PRIORITÀ ELITE: +15 Bonus per strategie Professionali (v2)
            let finalConfidence = Math.round(100 - mcDrawProb + oddsBonus) + 15;
            if (isRelegationFight) finalConfidence += 5; // Più tensione = meno pareggi

            strategies.push({
                type: 'LAY_THE_DRAW',
                confidence: Math.min(95, finalConfidence),
                data: { mcDrawProb, avgHistDraw, homeDrawRate, awayDrawRate, drawOdds, badges },
                create: () => {
                    const s = createLayTheDrawStrategy(match, avgHistDraw, homeDrawRate, awayDrawRate, mcDrawProb < 28 && avgHistDraw < 28, Math.min(95, finalConfidence));
                    s.reasoning = `Analisi LTD (Pareggio AI: ${Math.round(mcDrawProb)}%). ` +
                        (isRelegationFight ? "Tensione salvezza riduce rischio pareggio stallo." : "Margine di valore su odds Betfair.");
                    return s;
                }
            });
        }
    }

    // ─── STRATEGIA 2: SECOND HALF SURGE (O0.5 2T) ───
    if (prob >= 65 && prob < 90) {
        let finalConfidence = Math.round(prob * 0.8 + 15) + 10; // +10 Bonus Professionale (v2)
        if (hasMotivation) finalConfidence += 5;

        strategies.push({
            type: 'SECOND_HALF_SURGE',
            confidence: Math.min(95, finalConfidence),
            data: { prob, badges },
            create: () => {
                const s = createSecondHalfSurgeStrategy(match, allMatches, Math.min(95, finalConfidence));
                s.reasoning = `Prevista spinta nel 2° tempo (${prob}%). ` +
                    (hasMotivation ? `Obiettivi classifica (${badges.join(', ')}) spingono alla vittoria.` : "");
                return s;
            }
        });
    }

    // ─── STRATEGIA 6 (NUOVA): ELITE SURGE (High-Gap Trading) ───
    if (Math.abs(eloDiff) > 250) {
        const favoriteBadge = eloDiff > 0 ? "Home Favorite" : "Away Favorite";
        strategies.push({
            type: 'ELITE_SURGE',
            confidence: Math.min(97, 85 + (Math.abs(eloDiff) / 50)),
            data: { eloDiff, badges },
            create: (overrideConf) => ({
                strategy: 'ELITE_SURGE',
                label: 'ELITE SURGE (BACK)',
                action: eloDiff > 0 ? 'BACK 1' : 'BACK 2',
                entryRange: ['Live @ 1.80+'],
                exitTarget: '60 min / 1 Gol',
                timing: 'In-Play (0-15 min)',
                confidence: overrideConf || Math.min(97, 85 + (Math.abs(eloDiff) / 50)),
                reasoning: `Gap tecnico ELO massivo (${Math.round(Math.abs(eloDiff))}). Attesa dominanza del favorito.`
            })
        });
    }

    // ─── STRATEGIA 4: UNDER 3.5 SCALPING ───
    const under35Prob = 100 - (magicData?.over25 ? magicData.over25 : (magicData?.over25Prob || 50)) + 15;
    if (under35Prob >= 60 && !hasMotivation) { // Meno under se c'è motivazione (partita aperta)
        const confidence = Math.round(under35Prob * 0.7 + 15);
        strategies.push({
            type: 'UNDER_35_SCALPING',
            confidence: Math.min(90, confidence),
            data: { under35Prob },
            create: (overrideConf) => {
                const finalConf = overrideConf || Math.min(90, Math.round(under35Prob * 0.7 + 15));
                const s = createUnder35TradingStrategy(match, finalConf);
                s.reasoning = `Match a basso ritmo previsto (${Math.round(under35Prob)}%). Assenza di spinte motivazionali forti.`;
                return s;
            }
        });
    }

    // ════════════════════════════════════════════════════════════════
    // SELEZIONE: Scegli la strategia con CONFIDENCE più alta
    // HT SNIPER solo come FALLBACK se non ci sono altre strategie
    // ════════════════════════════════════════════════════════════════

    // ELITE DIVERSITY: Se abbiamo già una strategia professionale solida (>65%), 
    // l'HT Sniper non deve nemmeno essere proposto per evitare "rumore" e over-selection.
    const hasSolidProfessional = strategies.some(s =>
        ['BACK_OVER_25', 'LAY_THE_DRAW', 'ELITE_SURGE', 'SECOND_HALF_SURGE'].includes(s.type) && s.confidence > 65
    );

    if (strategies.length === 0 && htSniperCandidate) {
        strategies.push(htSniperCandidate);
    } else if (strategies.length > 0 && htSniperCandidate && !hasSolidProfessional) {
        // Aggiungiamo HT Sniper solo se NON abbiamo già una professionale solida
        strategies.push(htSniperCandidate);
    }

    if (strategies.length === 0) {
        console.log(`[Trading 3.0] ❌ ${match.partita}: Nessuna strategia qualificata`);
        return null;
    }

    // Ordina per confidence decrescente con Professional First Rule
    strategies.sort((a, b) => {
        const isAProf = ['BACK_OVER_25', 'LAY_THE_DRAW', 'ELITE_SURGE', 'SECOND_HALF_SURGE'].includes(a.type);
        const isBProf = ['BACK_OVER_25', 'LAY_THE_DRAW', 'ELITE_SURGE', 'SECOND_HALF_SURGE'].includes(b.type);

        // Professional First: Se una professionale ha confidende > 70%, vince su HT Sniper non-eccelso
        if (isAProf && !isBProf && a.confidence >= 70 && b.confidence < 90) return -1;
        if (!isAProf && isBProf && b.confidence >= 70 && a.confidence < 90) return 1;

        return b.confidence - a.confidence;
    });

    const bestStrategy = strategies[0];

    // 🔍 DEBUG ELITE: Log finale per l'utente sui pesi del ranking
    console.log(`[Elite Debug] Rank Finale per ${match.partita}:`);
    strategies.forEach((s, idx) => {
        const isProf = ['BACK_OVER_25', 'LAY_THE_DRAW', 'ELITE_SURGE', 'SECOND_HALF_SURGE'].includes(s.type);
        console.log(`  ${idx + 1}. ${s.type} | Conf: ${s.confidence}% | Professional: ${isProf}`);
    });
    console.log(`  🏆 Vincitore: ${bestStrategy.type} (${bestStrategy.confidence}%)`);

    // Crea e ritorna la strategia vincente - PASSA LA CONFIDENCE PESATA
    const result = bestStrategy.create(bestStrategy.confidence);
    if (result) {
        // LIMITA A MAX 3 STRATEGIE per evitare "sempre le solite 2"
        const topStrategies = strategies.slice(0, 3);

        result._allPossibleStrategies = topStrategies.map(s => {
            const stratObj = s.create();
            // Merge metadata with the full strategy object
            return {
                ...stratObj, // Include instructions, badges, etc.
                type: s.type,
                confidence: s.confidence,
                label: stratObj?.badge?.text || stratObj?.tradingInstruction?.action || s.type,
                reasoning: stratObj?.reasoning || ''
            };
        });
        return result;
    }
    return null;
}

/**
 * NEW: Calculate ALL qualified strategies for a match (not just the best one)
 */
function calculateAllTradingStrategies(match, allMatches) {
    const prob = match.probabilita || 0;
    const htProb = extractHTProb(match.info_ht);
    const magicData = match.magicStats;
    const score = magicData?.score || match.score || 0;
    const teams = (match.partita || "").split(' - ');

    const qualified = [];

    // ANALISI ELITE
    const badges = magicData?.motivationBadges || [];
    const hasMotivation = badges.length > 0;
    const isDirectClash = badges.includes('⚔️ Scontro Diretto');
    const isTitleRace = badges.includes('🏆 Corsa Titolo');
    const isRelegationFight = badges.includes('🆘 Lotta Salvezza');

    // 1. BACK OVER 2.5
    const over25Prob = magicData?.over25 ? magicData.over25 : (magicData?.over25Prob || 0);
    if (over25Prob >= 45 || score >= 60) {
        const conf = Math.min(98, Math.round((over25Prob * 0.6) + (score * 0.4)) + 15 + (hasMotivation ? 5 : 0));
        const s = createBackOver25Strategy(match, htProb, allMatches, conf);
        if (s) {
            qualified.push({
                type: 'BACK_OVER_25',
                confidence: conf,
                entryRange: s.tradingInstruction?.entry || null,
                exitTarget: s.tradingInstruction?.exit || null,
                reasoning: s.reasoning || null,
                tradingInstruction: s.tradingInstruction
            });
        }
    }

    // 2. LAY THE DRAW
    if (teams.length === 2) {
        const homeDrawRate = analyzeDrawRate(teams[0].trim(), allMatches);
        const awayDrawRate = analyzeDrawRate(teams[1].trim(), allMatches);
        const avgHistDraw = (homeDrawRate.rate + awayDrawRate.rate) / 2;
        const mcDrawProb = magicData?.drawProb || 30;
        const isBiscottoRisk = isDirectClash && mcDrawProb > 33;

        if ((mcDrawProb < 35 || avgHistDraw < 35) && !isBiscottoRisk) {
            let conf = Math.round(100 - ((mcDrawProb * 0.7) + (avgHistDraw * 0.3))) + 15;
            if (isRelegationFight) conf += 5;

            const s = createLayTheDrawStrategy(match, avgHistDraw, homeDrawRate, awayDrawRate, mcDrawProb < 25 && avgHistDraw < 28, Math.min(95, conf));
            if (s) {
                qualified.push({
                    type: 'LAY_THE_DRAW',
                    confidence: Math.min(95, conf),
                    entryRange: s.tradingInstruction?.entry || null,
                    exitTarget: s.tradingInstruction?.exit || null,
                    reasoning: s.reasoning || null,
                    tradingInstruction: s.tradingInstruction
                });
            }
        }
    }

    // 3. SECOND HALF SURGE
    if (score >= 55 && prob >= 50) {
        const conf = Math.min(95, Math.round((score * 0.5) + (prob * 0.3) + 15) + 10);
        const s = createSecondHalfSurgeStrategy(match, allMatches, conf);
        if (s) {
            qualified.push({
                type: 'SECOND_HALF_SURGE',
                confidence: conf,
                entryRange: s.tradingInstruction?.entry || null,
                exitTarget: s.tradingInstruction?.exit || null,
                reasoning: s.reasoning || null,
                tradingInstruction: s.tradingInstruction
            });
        }
    }

    // 4. UNDER 3.5 SCALPING
    const under35Prob = 100 - (over25Prob || 50) + 15;
    if (under35Prob >= 60 && !hasMotivation) {
        const conf = Math.min(90, Math.round(under35Prob * 0.7 + 15));
        const s = createUnder35TradingStrategy(match, conf);
        if (s) {
            qualified.push({
                type: 'UNDER_35_SCALPING',
                confidence: conf,
                entryRange: s.tradingInstruction?.entry || null,
                exitTarget: s.tradingInstruction?.exit || null,
                reasoning: s.reasoning || null,
                tradingInstruction: s.tradingInstruction
            });
        }
    }

    // 5. HT SNIPER (Sempre per ultimo per sorpasso professional)
    const htGoalProb = magicData?.htGoalProb || htProb;
    if (htProb >= 65 || htGoalProb >= 60) {
        const conf = Math.min(95, Math.round(Math.max(htProb, htGoalProb)) + (isTitleRace ? 5 : 0)) - 25;
        const s = createHTSniperStrategy(match, htProb, conf);
        if (s) {
            qualified.push({
                type: 'HT_SNIPER',
                confidence: conf,
                entryRange: s.tradingInstruction?.entry || null,
                exitTarget: s.tradingInstruction?.exit || null,
                reasoning: s.reasoning || null,
                tradingInstruction: s.tradingInstruction
            });
        }
    }

    // Sort: Professional First Rule
    qualified.sort((a, b) => {
        const profTypes = ['BACK_OVER_25', 'LAY_THE_DRAW', 'ELITE_SURGE', 'SECOND_HALF_SURGE'];
        const isAProf = profTypes.includes(a.type);
        const isBProf = profTypes.includes(b.type);

        // Se una professionale ha almeno il 60%, batte HT Sniper a meno che non sia > 90%
        if (isAProf && !isBProf && a.confidence >= 60 && b.confidence < 90) return -1;
        if (!isAProf && isBProf && b.confidence >= 60 && a.confidence < 90) return 1;

        return b.confidence - a.confidence;
    });

    return qualified;
}


function generateTradingBadge(match, is05HT = false, team1Stats = null, team2Stats = null) {
    const tip = (match.tip || '').trim().toUpperCase();
    const score = match.magicStats?.score || match.score || 0;

    // Estrai HT prob se disponibile
    let htProb = 0;
    if (match.info_ht && match.info_ht.trim() !== '') {
        const htMatch = match.info_ht.match(/(\d+)%/);
        if (htMatch) htProb = parseInt(htMatch[1]);
    }

    let tradingBadge = null;

    // SPECIALE: Filtro BEST 0.5 HT → Badge dinamico basato su prolificità
    if (is05HT && htProb >= 70 && score >= 50 && team1Stats && team2Stats) {
        // Calcola prolificità media squadre per Over 2.5
        const team1Over25 = team1Stats.total >= 5 ? (team1Stats.count / team1Stats.total) * 100 : 0;
        const team2Over25 = team2Stats.total >= 5 ? (team2Stats.count / team2Stats.total) * 100 : 0;
        const avgProlificita = (team1Over25 + team2Over25) / 2;

        // Badge dinamico basato su prolificità
        if (avgProlificita >= 75) {
            tradingBadge = {
                text: 'Trading Back Over 2.5',
                color: 'bg-yellow-100 text-yellow-700 border-yellow-300'
            };
        } else if (avgProlificita >= 60) {
            tradingBadge = {
                text: 'Trading Scalping Over 1.5',
                color: 'bg-blue-100 text-blue-700 border-blue-300'
            };
        } else {
            tradingBadge = {
                text: 'Trading Gol 1° Tempo',
                color: 'bg-green-100 text-green-700 border-green-300'
            };
        }
        return tradingBadge;
    }

    // STANDARD: Logica normale per altre strategie
    if (tip === '+1.5' && htProb >= 75) {
        tradingBadge = {
            text: 'Trading Gol 1° Tempo',
            color: 'bg-green-100 text-green-700 border-green-300'
        };
    } else if (tip === '+2.5') {
        tradingBadge = {
            text: 'Trading Back Over 2.5',
            color: 'bg-purple-100 text-purple-700 border-purple-300'
        };
    } else if (['1', '2'].includes(tip) && score >= 70) {
        tradingBadge = {
            text: 'Trading Lay The Draw',
            color: 'bg-blue-100 text-blue-700 border-blue-300'
        };
    }

    return tradingBadge;
}

// ==================== MONTE CARLO ENGINE ====================

/**
 * Seeded Random Number Generator (Mulberry32)
 * Ensures deterministic results for the same match/seed.
 */
class SeededRandom {
    constructor(seedString) {
        // Create a hash from the string to use as numeric seed
        let h = 0x811c9dc5;
        if (seedString) {
            for (let i = 0; i < seedString.length; i++) {
                h ^= seedString.charCodeAt(i);
                h = Math.imul(h, 0x01000193);
            }
        } else {
            h = Math.floor(Math.random() * 0xFFFFFFFF);
        }
        this.state = h >>> 0;
    }

    // Returns a float between 0 and 1
    next() {
        let t = (this.state += 0x6D2B79F5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        this.state = t >>> 0; // update state
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}

/**
 * Generates a random number based on Poisson distribution
 * (Knuth's algorithm) - Now accepts a custom RNG
 */
function poissonRandom(lambda, rng = null) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
        k++;
        p *= rng ? rng.next() : Math.random();
    } while (p > L);
    return k - 1;
}

// ==================== MONTE CARLO ENGINE (TRUE SIMULATION) ====================

/**
 * Generates a random number based on Poisson distribution
 */
function poissonRandom(lambda) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
        k++;
        p *= Math.random();
    } while (p > L);
    return k - 1;
}

/**
 * Dixon-Coles Correction Function
 * Adjusts probability for low scores (0-0, 1-0, 0-1, 1-1)
 */
function dixonColesCorrection(hg, ag, rho, lambdaHome, lambdaAway) {
    if (hg === 0 && ag === 0) return 1 - (lambdaHome * lambdaAway * rho);
    if (hg === 0 && ag === 1) return 1 + (lambdaHome * rho);
    if (hg === 1 && ag === 0) return 1 + (lambdaAway * rho);
    if (hg === 1 && ag === 1) return 1 - rho;
    return 1;
}

/**
 * Runs a TRUE Monte Carlo simulation for a match
 * Returns raw data for density analysis
 */
function simulateMatch(lambdaHome, lambdaAway, iterations = 10000, seedString = "", entropy = 1.0) {
    // Determine seed for reproducible results
    // If no seed provided, utilize Math.random via SeededRandom wrapper or just null to use fallback
    const rng = seedString ? new SeededRandom(seedString) : null;
    const results = {
        homeWins: 0, draws: 0, awayWins: 0,
        dc1X: 0, dcX2: 0, dc12: 0,
        over15: 0, over25: 0, under35: 0,
        btts: 0, noGol: 0,
        scores: {}, // Exact score frequency
        homeCleanSheet: 0, awayCleanSheet: 0
    };

    // Dixon-Coles Rho
    const rho = (typeof STRATEGY_CONFIG !== 'undefined' ? STRATEGY_CONFIG.ENGINE.DIXON_COLES_RHO : -0.11);

    for (let i = 0; i < iterations; i++) {
        // Apply entropy "jitter" to lambda values to model league chaos
        let currentLambdaHome = lambdaHome;
        let currentLambdaAway = lambdaAway;

        if (entropy !== 1.0) {
            const jitterRange = (entropy - 1.0) * 0.3; // E.g., 1.25 entropy = ±0.075 jitter
            const jitterH = (Math.random() * jitterRange * 2) - jitterRange;
            const jitterA = (Math.random() * jitterRange * 2) - jitterRange;
            currentLambdaHome = Math.max(0.1, lambdaHome + jitterH);
            currentLambdaAway = Math.max(0.1, lambdaAway + jitterA);
        }

        const hg = poissonRandom(currentLambdaHome, rng);
        const ag = poissonRandom(currentLambdaAway, rng);

        // Apply Dixon-Coles weighting via rejection sampling or basic correction
        // For Monte Carlo, we weight the count by the correction factor
        const weight = dixonColesCorrection(hg, ag, rho, lambdaHome, lambdaAway);

        // Instead of increments of 1, we increment by weight
        const totalGoals = hg + ag;

        // 1X2
        if (hg > ag) results.homeWins += weight;
        else if (hg === ag) results.draws += weight;
        else results.awayWins += weight;

        // Double Chance
        if (hg >= ag) results.dc1X += weight;
        if (ag >= hg) results.dcX2 += weight;
        if (hg !== ag) results.dc12 += weight;

        // Goals
        if (totalGoals > 1.5) results.over15 += weight;
        if (totalGoals > 2.5) results.over25 += weight;
        if (totalGoals < 3.5) results.under35 += weight;

        // BTTS
        if (hg > 0 && ag > 0) results.btts += weight;
        else results.noGol += weight;

        // Clean Sheets
        if (ag === 0) results.homeCleanSheet += weight;
        if (hg === 0) results.awayCleanSheet += weight;

        // Exact Score
        const key = `${hg}-${ag}`;
        results.scores[key] = (results.scores[key] || 0) + weight;
    }

    // Normalize counts to get probabilities
    const sumWeights = Object.values(results.scores).reduce((a, b) => a + b, 0);

    // Process Exact Scores
    const sortedScores = Object.entries(results.scores)
        .sort(([, a], [, b]) => b - a)
        .map(([score, count]) => ({
            score,
            percent: Math.round((count / sumWeights) * 100),
            rawCount: count
        }));

    return {
        // Probabilities (11 Markets)
        winHome: Math.round((results.homeWins / sumWeights) * 100),
        draw: Math.round((results.draws / sumWeights) * 100),
        winAway: Math.round((results.awayWins / sumWeights) * 100),
        dc1X: Math.round((results.dc1X / sumWeights) * 100),
        dcX2: Math.round((results.dcX2 / sumWeights) * 100),
        dc12: Math.round((results.dc12 / sumWeights) * 100),
        over15: Math.round((results.over15 / sumWeights) * 100),
        over25: Math.round((results.over25 / sumWeights) * 100),
        under35: Math.round((results.under35 / sumWeights) * 100),
        btts: Math.round((results.btts / sumWeights) * 100),
        noGol: Math.round((results.noGol / sumWeights) * 100),

        // Rischi
        homeCleanSheetProb: Math.round((results.homeCleanSheet / sumWeights) * 100),
        awayCleanSheetProb: Math.round((results.awayCleanSheet / sumWeights) * 100),

        // Core Data
        exactScores: sortedScores,
        mostFrequentScore: sortedScores[0]
    };
}

/**
 * Determines the "Safety Level" (Density) of the prediction
 */
function calculateSafetyLevel(simStats) {
    const topScorePerc = simStats.mostFrequentScore.percent;
    const top3Sum = simStats.exactScores.slice(0, 3).reduce((sum, s) => sum + s.percent, 0);

    if (topScorePerc >= 14 || top3Sum >= 35) return { level: 'ALTA', color: 'green', label: 'Alta Stabilità' };
    if (topScorePerc >= 10 || top3Sum >= 25) return { level: 'MEDIA', color: 'yellow', label: 'Media Stabilità' };
    return { level: 'BASSA', color: 'red', label: 'Bassa Stabilità (Rischio)' };
}

/**
 * Generates the "Magia AI" Strategy
 * "THE PROFESSIONAL SCANNER" Logic
 */
/**
 * Generates the "Magia AI" Strategy
 * "THE PROFESSIONAL SCANNER" Logic
 */
function generateMagiaAI(matches, allMatchesHistory) {
    const magicMatches = [];

    matches.forEach(match => {
        if (!match.lega) return;
        const teams = parseTeams(match.partita);
        if (!teams) return;

        // Ensure magicStats exists (it should from Step 1)
        if (!match.magicStats) {
            // 🔥 DEBUG: Log missing magicStats
            console.log(`[Magia AI] Skip: ${match.partita} - NO magicStats (Step 1 non eseguito o non salvato)`);
            return;
        }

        let sim = match.magicStats;

        // ═══════════════════════════════════════════════════════════════════════
        // MAGIA AI 3.0: FILTRO VALORE (Tartufo da 10.000€!)
        // ═══════════════════════════════════════════════════════════════════════

        // 🔥 FILTRO 1: RICHIEDI QUOTE API REALI (no stimate)
        const hasRealApiOdds = match.quota1 && match.quotaX && match.quota2 &&
            parseFloat(match.quota1) > 1 &&
            parseFloat(match.quotaX) > 1 &&
            parseFloat(match.quota2) > 1;

        if (!hasRealApiOdds) {
            // Match senza quote API reali → escluso da Magia AI
            // Sarà comunque nelle altre strategie (ALL, Italia, etc.)
            console.log(`[Magia AI] Skip: ${match.partita} - NO quote API reali`);
            return;
        }

        // 🔥 FILTRO 2: QUOTA MINIMA GIOCABILE (il vero tartufo!)
        const MIN_PLAYABLE_ODD = 1.25;

        // MAP ALL SIGNALS
        const allSignals = [
            { label: '1', prob: sim.winHome, type: '1X2' },
            { label: 'X', prob: sim.draw, type: '1X2' },
            { label: '2', prob: sim.winAway, type: '1X2' },
            { label: '1X', prob: sim.dc1X, type: 'DC' },
            { label: 'X2', prob: sim.dcX2, type: 'DC' },
            { label: '12', prob: sim.dc12, type: 'DC' },
            { label: 'Over 1.5', prob: sim.over15, type: 'GOALS' },
            { label: 'Over 2.5', prob: sim.over25, type: 'GOALS' },
            { label: 'Under 3.5', prob: sim.under35, type: 'GOALS' },
            { label: 'Gol', prob: sim.btts, type: 'GOALS' },
            { label: 'No Gol', prob: sim.noGol, type: 'GOALS' }
        ].sort((a, b) => b.prob - a.prob);

        const THRESHOLDS = STRATEGY_CONFIG.MAGIA_AI.THRESHOLDS;
        const FALLBACK = STRATEGY_CONFIG.MAGIA_AI.FALLBACK;

        const getThreshold = (signal) => {
            const cfg = THRESHOLDS.find(t =>
                (t.type === signal.type && t.label === signal.label) ||
                (t.type === signal.type && !t.label)
            );
            return cfg ? cfg.minProb : 75;
        };

        // 2. FILTER CANDIDATES
        let topCandidates = allSignals.slice(0, 5).filter(s => s.prob >= getThreshold(s));

        // 3. FALLBACK HT
        const htProb = match.info_ht ? parseInt((match.info_ht.match(/(\d+)%/) || [])[1] || 0) : 0;
        if (topCandidates.length === 0 && htProb >= (FALLBACK.minProb || 88)) {
            topCandidates = [{
                label: FALLBACK.label || 'Over 0.5 HT',
                prob: htProb,
                type: FALLBACK.type || 'HT_FALLBACK',
                estimatedOdd: (100 / htProb).toFixed(2)
            }];
        }

        if (topCandidates.length === 0) return;

        // 3. CALCOLA SMART SCORE
        const scoredCandidates = topCandidates.map(signal => {
            let realOdd = null;

            // Try to use match odds if available (Basic Manual or API)
            // Note: In Step 2, we might not have 'quota1' populated from API yet.
            // We can fall back to 'match.quota' if it matches the current tip, but unreliable.

            if (hasRealApiOdds) {
                const bet365Odds = {
                    '1': parseFloat(match.quota1),
                    'X': parseFloat(match.quotaX),
                    '2': parseFloat(match.quota2)
                };
                if (signal.label === '1') realOdd = bet365Odds['1'];
                else if (signal.label === 'X') realOdd = bet365Odds['X'];
                else if (signal.label === '2') realOdd = bet365Odds['2'];
                else if (signal.label === '1X') realOdd = 1 / ((1 / bet365Odds['1']) + (1 / bet365Odds['X']));
                else if (signal.label === 'X2') realOdd = 1 / ((1 / bet365Odds['X']) + (1 / bet365Odds['2']));
                else if (signal.label === '12') realOdd = 1 / ((1 / bet365Odds['1']) + (1 / bet365Odds['2']));
            }

            const estimatedOdd = realOdd || (100 / signal.prob);

            const cfg = THRESHOLDS.find(t => t.type === signal.type && t.label === signal.label);
            const minOdd = cfg ? cfg.minOdd : 1.20;

            let totalScore = signal.prob;

            // Value Trap Check (only if we have high confidence in the odd)
            if (hasRealApiOdds && estimatedOdd < minOdd) {
                totalScore -= 50;
            }
            // Value Bet Bonus
            if (estimatedOdd > 1.80 && signal.prob > 60) {
                totalScore += 10;
            }

            return {
                ...signal,
                finalScore: totalScore,
                estimatedOdd: typeof estimatedOdd === 'number' ? estimatedOdd.toFixed(2) : estimatedOdd,
                isValue: estimatedOdd >= minOdd // Soft filter: prefer values, but dont kill purely on missing odd
            };
        });

        // 🔥 FILTRO 2: Applica quota minima giocabile
        const winners = scoredCandidates
            .filter(s => {
                const odd = parseFloat(s.estimatedOdd);
                if (odd < MIN_PLAYABLE_ODD) {
                    console.log(`[Magia AI] Skip segnale ${match.partita}: ${s.label} @${odd} (< ${MIN_PLAYABLE_ODD})`);
                    return false;
                }
                return s.finalScore > 0;
            })
            .sort((a, b) => b.finalScore - a.finalScore);

        if (winners.length > 0) {
            const bestPick = winners[0];

            // 🔥 Top 3 Risultati Esatti per Admin Card
            const top3Scores = (sim.exactScores || []).slice(0, 3).map(s => ({
                score: s.score,
                percent: s.percent
            }));

            // 🔥 Segnale Rafforzato: AI tip = DB tip?
            const isReinforced = bestPick.label === match.tip ||
                bestPick.label === match.tip?.replace('+', 'Over ').replace('-', 'Under ');

            magicMatches.push({
                ...match,
                // Override main props for UI display (Strategy View)
                tip: bestPick.label,        // Magia AI Tip
                quota: bestPick.estimatedOdd, // Magia AI Odd
                score: Math.min(100, Math.round(bestPick.finalScore)),

                // Keep Original Data for comparison in UI (Card)
                originalDBTip: match.tip,
                originalDBQuota: match.quota,

                // Magia Metadata
                strategy: 'magia_ai',
                magicStats: {
                    ...sim,
                    tipMagiaAI: bestPick.label,
                    probMagiaAI: bestPick.prob,
                    oddMagiaAI: bestPick.estimatedOdd,
                    smartScore: bestPick.finalScore,
                    top3Scores: top3Scores,           // 🔥 Top 3 risultati esatti
                    isReinforced: isReinforced        // 🔥 Badge convergenza
                },
                reasoning: `Magia AI: ${bestPick.label} (${bestPick.prob}%)`,

                // 🔥 Campi extra per Admin Card
                top3Scores: top3Scores,
                isReinforced: isReinforced
            });
        }
    });

    return magicMatches;
}

/**
 * ORCHESTRATOR: Distributes matches to strategies using pre-calculated stats.
 * This function is the core of Step 2B.
 */
function distributeStrategies(calculatedMatches, allMatchesHistory) {
    if (!calculatedMatches || calculatedMatches.length === 0) return {};

    const results = {};

    // 1. Magia AI (Clean Selection)
    // Assumes generateMagiaAI returns an array of enriched matches
    const magicMatches = generateMagiaAI(calculatedMatches, allMatchesHistory);
    results['magia_ai'] = {
        id: 'magia_ai',
        name: '🔮 MAGIA AI',
        matches: magicMatches || [],
        totalMatches: (magicMatches || []).length,
        type: 'monte_carlo',
        lastUpdated: Date.now()
    };

    // 2. Standard Strategies Definitions
    const strategies = [
        { id: 'all', name: '📊 ALL', type: 'all' },
        { id: 'italia', name: '🇮🇹 ITALIA', type: 'italia' },
        { id: 'top_eu', name: '🌍 TOP EU', type: 'top_eu' },
        { id: 'cups', name: '🏆 COPPE', type: 'cups' },
        { id: 'winrate_80', name: '🔥 WINRATE 80%', type: 'winrate_80' }
    ];

    // Pre-calculate Blacklist (Simplified: if we don't have blacklist loaded here, we skip it or assume calculatedMatches is clean enough? 
    // Actually calculatedMatches comes from Step 1 which includes EVERYTHING.
    // For "ALL" strategy we usually apply blacklist. 
    // Since we don't have easy access to blacklist array here, we will define "ALL" as truly ALL for now or rely on specific filtering)

    // Helper for Filters - CORRECTED ISO CODES matching database format
    const topEuLeagues = [
        'EU-ENG Premier League',     // Inghilterra
        'EU-ESP La Liga',            // Spagna
        'EU-DEU Bundesliga',         // Germania (DEU non GER!)
        'EU-FRA Ligue 1',            // Francia
        'EU-NED Eredivisie',         // Olanda
        'EU-CHE Super League',       // Svizzera (CHE non SWI!)
        'EU-PRT Primeira Liga',      // Portogallo (PRT non POR!)
        'EU-BEL Pro League'          // Belgio
    ];
    // CUPS: Solo coppe EUROPEE (Champions, Europa League, Conference)
    const cupKeywords = ['champions league', 'europa league', 'conference league'];

    // Pre-calc Winrate 80 stats
    let winrateLeagues = [];
    if (allMatchesHistory && allMatchesHistory.length > 0) {
        const leagueStats = {};
        allMatchesHistory.forEach(m => {
            if (!m.risultato) return;
            const lega = normalizeLega(m.lega);
            if (!leagueStats[lega]) leagueStats[lega] = { total: 0, wins: 0 };
            leagueStats[lega].total++;
            if (m.esito === 'Vinto') leagueStats[lega].wins++;
        });
        winrateLeagues = Object.keys(leagueStats).filter(lega => {
            const stats = leagueStats[lega];
            const winrate = stats.total > 0 ? (stats.wins / stats.total) * 100 : 0;
            return winrate >= 80 && stats.total >= 5;
        });
    }

    strategies.forEach(strat => {
        let filtered = [];

        if (strat.type === 'all') {
            // Include everything (Blacklist filtering should ideally happen, but let's pass all for now or filter empty tips)
            filtered = calculatedMatches.filter(m => m.tip && m.tip.trim() !== '');
        } else if (strat.type === 'italia') {
            filtered = calculatedMatches.filter(m => {
                const l = (m.lega || '').toLowerCase();
                return l.includes('italy') || l.includes('ita ') || l.includes('serie');
            });
        } else if (strat.type === 'top_eu') {
            // 🔍 DEBUG TOP EU - DETTAGLIATO
            console.log('🔍 [DEBUG TOP EU] topEuLeagues array:', topEuLeagues);
            console.log('🔍 [DEBUG TOP EU] topEuLeagues[2] (Bundesliga):', topEuLeagues[2]);
            console.log('🔍 [DEBUG TOP EU] Sample leghe from calculatedMatches:', calculatedMatches.slice(0, 5).map(m => m.lega));

            filtered = calculatedMatches.filter(m => {
                const l = (m.lega || '').toLowerCase().trim();

                // DEBUG: Confronto dettagliato per Bundesliga
                if (l.includes('bundesliga')) {
                    topEuLeagues.forEach((k, idx) => {
                        const kLower = k.toLowerCase().trim();
                        console.log(`🔍 [TOP EU COMPARE] l="${l}" vs k[${idx}]="${kLower}" -> EQUAL=${l === kLower}`);
                    });
                }

                const match = topEuLeagues.some(k => l === k.toLowerCase().trim());
                if (l.includes('bundesliga') || l.includes('premier') || l.includes('la liga') || l.includes('serie a')) {
                    console.log(`🔍 [DEBUG TOP EU] Lega "${m.lega}" -> l="${l}" -> match=${match}`);
                }
                return match;
            });
            console.log(`🔍 [DEBUG TOP EU] Filtered count: ${filtered.length}`);

        } else if (strat.type === 'cups') {
            // 🔍 DEBUG CUPS
            console.log('🔍 [DEBUG CUPS] cupKeywords:', cupKeywords);
            filtered = calculatedMatches.filter(m => {
                const l = (m.lega || '').toLowerCase();
                const match = cupKeywords.some(k => l.includes(k));
                if (l.includes('coppa') || l.includes('cup') || l.includes('champions') || l.includes('europa')) {
                    console.log(`🔍 [DEBUG CUPS] Lega "${m.lega}" -> match=${match}`);
                }
                return match;
            });
            console.log(`🔍 [DEBUG CUPS] Filtered count: ${filtered.length}`);
        } else if (strat.type === 'winrate_80') {
            filtered = calculatedMatches.filter(m => {
                return winrateLeagues.includes(normalizeLega(m.lega));
            });
        }

        // 🔍 DEBUG: Log ogni strategia
        console.log(`🔍 [DEBUG distributeStrategies] ${strat.id}: filtered.length = ${filtered.length}`);

        // SEMPRE salvare tutte le strategie, anche con 0 partite
        results[strat.id] = {
            id: strat.id,
            name: strat.name,
            matches: filtered,
            totalMatches: filtered.length,
            type: strat.type,
            lastUpdated: Date.now()
        };
    });



    // 3. Special AI Logic (Subset of Magia AI with high score)
    const specialAiMatches = magicMatches.filter(m => {
        const score = m.score || 0;
        const prob = m.magicStats ? m.magicStats.probMagiaAI : 0;
        // Requires high score + high win probability
        return score >= 85 && prob >= 80;
    });

    results['special_ai'] = {
        id: 'special_ai',
        name: '🤖 SPECIAL AI',
        matches: specialAiMatches || [],
        totalMatches: (specialAiMatches || []).length,
        type: 'monte_carlo_elite',
        lastUpdated: Date.now()
    };

    return results;
}



/**
 * Calcola i parametri Magia AI (Dixon-Coles) per una singola partita
 * Versione "viva" per trading ohne filtri di soglia confidence
 */
function getMagiaStats(match, allMatchesHistory) {
    const teams = parseTeams(match.partita);
    if (!teams) return null;

    const homeStats = analyzeTeamStats(teams.home, true, 'ALL', allMatchesHistory);
    const awayStats = analyzeTeamStats(teams.away, false, 'ALL', allMatchesHistory);

    if (homeStats.currForm.matchCount < 3 || awayStats.currForm.matchCount < 3) return null;

    // League Goal & Entropy Factors
    const leagueNorm = (match.lega || '').toLowerCase();
    let goalFactor = 1.0;
    let entropyFactor = 1.0;

    for (const [l, factor] of Object.entries(LEAGUE_GOAL_FACTORS)) {
        if (leagueNorm.includes(l)) {
            goalFactor = factor;
            break;
        }
    }

    for (const [l, factor] of Object.entries(LEAGUE_ENTROPY_FACTORS)) {
        if (leagueNorm.includes(l)) {
            entropyFactor = factor;
            break;
        }
    }

    // 🔥 POINT 3: MOTIVATION FACTOR (STANDINGS)
    let motivationH = 1.0;
    let motivationA = 1.0;

    // Check if standings are available for this league
    const leagueIdMap = window.LEAGUE_MAPPING || {};
    let leagueId = null;
    for (const [key, id] of Object.entries(leagueIdMap)) {
        if (leagueNorm.includes(key)) {
            leagueId = id;
            break;
        }
    }

    const cache = window.standingsCache;
    let standings = null;
    if (leagueId && cache) {
        // Support both Map (new) and object (old) structures
        if (typeof cache.get === 'function') {
            // Check for potential keys like standings_135_2024 or just 135
            standings = cache.get(leagueId) || cache.get(`standings_${leagueId}_2025`) || cache.get(`standings_${leagueId}_2024`);
        } else {
            standings = cache[leagueId];
        }
    }

    if (standings) {
        const stdH = standings.find(s =>
            s.team.name.toLowerCase().includes(teams.home.toLowerCase()) ||
            teams.home.toLowerCase().includes(s.team.name.toLowerCase())
        );
        const stdA = standings.find(s =>
            s.team.name.toLowerCase().includes(teams.away.toLowerCase()) ||
            teams.away.toLowerCase().includes(s.team.name.toLowerCase())
        );

        if (stdH && stdA) {
            const totalTeams = standings.length;
            sim.motivationBadges = [];

            // High Motivation: Fighting for Title/Europe (Top 4) or Relegation (Bottom 4)
            if (stdH.rank >= totalTeams - 4) {
                motivationH += 0.15;
                sim.motivationBadges.push({ team: 'H', type: 'SALVEZZA', label: 'Lotta Salvezza 🆘' });
            } else if (stdH.rank <= 4) {
                motivationH += 0.10;
                sim.motivationBadges.push({ team: 'H', type: 'TITOLO', label: 'Corsa Titolo/EU 🏆' });
            }

            if (stdA.rank >= totalTeams - 4) {
                motivationA += 0.15;
                sim.motivationBadges.push({ team: 'A', type: 'SALVEZZA', label: 'Lotta Salvezza 🆘' });
            } else if (stdA.rank <= 4) {
                motivationA += 0.10;
                sim.motivationBadges.push({ team: 'A', type: 'TITOLO', label: 'Corsa Titolo/EU 🏆' });
            }

            // Direct Clash: If teams are within 3 points of each other
            if (Math.abs(stdH.points - stdA.points) <= 3) {
                motivationH += 0.05;
                motivationA += 0.05;
                sim.motivationBadges.push({ team: 'B', type: 'SCONTRO', label: 'Scontro Diretto ⚔️' });
            }
        }
    }

    const lambdaHome = ((homeStats.currForm.avgScored * 0.6 + homeStats.season.avgScored * 0.4 +
        awayStats.currForm.avgConceded * 0.6 + awayStats.season.avgConceded * 0.4) / 2) * goalFactor * motivationH;
    const lambdaAway = ((awayStats.currForm.avgScored * 0.6 + awayStats.season.avgScored * 0.4 +
        homeStats.currForm.avgConceded * 0.6 + homeStats.season.avgConceded * 0.4) / 2) * goalFactor * motivationA;

    const sim = simulateMatch(lambdaHome, lambdaAway, 10000, match.partita, entropyFactor);
    /**
     * STATISTICAL ENGINE v4.0.0 - ELITE MODE REFINED
     * Last update: 17/01/2026 - Bugfix HT Sniper Confidence
     */
    console.log('%c[Elite Engine 4.0] Logic Initialized | Professional First Active', 'color: #00ff00; font-weight: bold; background: #000; padding: 5px;');
    // Adjust probabilities based on ELO difference if available
    if (window.teamELORatings) {
        const rH = window.teamELORatings.get(teams.home) || 1500;
        const rA = window.teamELORatings.get(teams.away) || 1500;
        const eloDiff = rH - rA;

        // Adjust Home/Away win probs based on ELO gap (Max 15% shift)
        const eloSift = Math.max(-15, Math.min(15, eloDiff / 40));

        sim.winHome = Math.max(5, Math.min(95, sim.winHome + eloSift));
        sim.winAway = Math.max(5, Math.min(95, sim.winAway - eloSift));

        // Recalculate Double Chances
        sim.dc1X = Math.round(sim.winHome + sim.draw);
        sim.dcX2 = Math.round(sim.winAway + sim.draw);
        sim.dc12 = Math.round(sim.winHome + sim.winAway);

        sim.eloRatingH = Math.round(rH);
        sim.eloRatingA = Math.round(rA);
        sim.eloDiff = Math.round(eloDiff);
    }

    // Hybrid refinement (Draw Penalty)
    const histHomeDraw = (homeStats.season.draws / homeStats.season.matches) * 100 || 25;
    const histAwayDraw = (awayStats.season.draws / awayStats.season.matches) * 100 || 25;
    const avgHistDraw = (histHomeDraw + histAwayDraw) / 2;
    let hybridDraw = (sim.draw * 0.7) + (avgHistDraw * 0.3);

    const dbTip = (match.tip || '').trim();
    if (dbTip === '1' || dbTip === '2') {
        hybridDraw = hybridDraw * 0.90;
    }

    // Normalize
    const remainder = 100 - hybridDraw;
    const ratio = remainder / (sim.winHome + sim.winAway);
    sim.draw = hybridDraw;
    sim.winHome = sim.winHome * ratio;
    sim.winAway = sim.winAway * ratio;

    const allSignals = [
        { label: '1', prob: sim.winHome, type: '1X2' },
        { label: 'X', prob: sim.draw, type: '1X2' },
        { label: '2', prob: sim.winAway, type: '1X2' },
        { label: 'Over 2.5', prob: sim.over25, type: 'GOALS' }
    ].sort((a, b) => b.prob - a.prob);

    return {
        // Core probabilities
        winHome: sim.winHome,
        draw: sim.draw,
        winAway: sim.winAway,
        dc1X: sim.dc1X,
        dcX2: sim.dcX2,
        dc12: sim.dc12,

        // Goal markets
        over15: sim.over15,
        over25: sim.over25,
        under35: sim.under35,
        btts: sim.btts,
        noGol: sim.noGol,

        // Meta & AI
        tipMagiaAI: allSignals[0].label,
        oddMagiaAI: 1.50, // Placeholder or calculated if available
        confidence: allSignals[0].prob,
        score: allSignals[0].prob,

        // New Advanced metrics
        eloRatingH: sim.eloRatingH,
        eloRatingA: sim.eloRatingA,
        eloDiff: sim.eloDiff,
        motivationBadges: sim.motivationBadges || []
    };
}

// parseTeams moved to js/utils.js

// Export functions
window.calculateStrategyRankings = null; // Will be defined in admin logic, not here
window.engine = {
    poissonProbability: null, // Removed simple Poisson, replaced by Monte Carlo
    analyzeTeamStats,
    calculateScore,
    generateTradingBadge,
    // checkLiquidity removed
    simulateMatch,
    getMagiaStats,
    generateMagiaAI,
    // Trading Strategy Functions
    transformToTradingStrategy,
    createBackOver25Strategy,
    createHTSniperStrategy,
    createLayTheDrawStrategy,
    createSecondHalfSurgeStrategy,
    createUnder35TradingStrategy,
    extractHTProb,
    analyzeDrawRate,
    // NEW: Value Edge calculation
    calculateValueEdge,
    calculateELORatings, // Added calculateELORatings
    parseTeams, // Added parseTeams for consistency
    MIN_VALUE_EDGE: (typeof STRATEGY_CONFIG !== 'undefined' ? STRATEGY_CONFIG.TRADING.MIN_VALUE_EDGE : 3.0)
};
