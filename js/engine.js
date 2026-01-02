// ==================== CONFIGURATION & CONSTANTS ====================

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

const DIXON_COLES_RHO = -0.11; // Correction for under-represented low scores (0-0, 1-1)

// ==================== DATA NORMALIZATION ====================

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

    // Calc Goals Stats (Season Average)
    let totalScored = 0;
    let totalConceded = 0;
    allTeamMatches.forEach(m => {
        const team1 = (m.partita || '').split(' - ')[0]?.toLowerCase().trim() || '';
        const isTeamHome = team1 === teamNorm;
        const res = m.risultato.match(/(\d+)-(\d+)/);
        if (res) {
            const hg = parseInt(res[1]);
            const ag = parseInt(res[2]);
            totalScored += isTeamHome ? hg : ag;
            totalConceded += isTeamHome ? ag : hg;
        }
    });

    const seasonStats = {
        avgScored: allTeamMatches.length ? totalScored / allTeamMatches.length : 1.3,
        avgConceded: allTeamMatches.length ? totalConceded / allTeamMatches.length : 1.2
    };

    if (tip === 'ALL') {
        // Return rich stats strictly for Monte Carlo
        // Current Form (Last 5)
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
    const liquidity = checkLiquidity(match.lega);
    if (liquidity.skip) {
        return null; // Skip low liquidity leagues for trading
    }
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
            entryRange: entryRange,
            exitTarget: 'Dopo 1° gol o minuto 70',
            timing: 'Primi 10 minuti di gioco'
        },
        confidence: Math.min(95, (match.score || 70) + (isConvergent ? 10 : 3)),
        reasoning: reasoning.join(' + ') + ` | Liquidità: ${liquidity.rating} ${liquidity.badge}`,
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

// LIQUIDITY FILTER SYSTEM
// HIGH LIQUIDITY: Leghe con massima liquidità exchange italiani
const HIGH_LIQUIDITY_LEAGUES = [
    'EU-ITA Serie A',
    'EU-ENG Premier League',
    'EU-ESP La Liga',
    'EU-GER Bundesliga',
    'EU-FRA Ligue 1',
    'EU-ITA Serie B',  // Anche B ha buona liquidità in Italia
    'Europe UEFA Champions League',
    'Europe UEFA Europa League'
];

// MEDIUM LIQUIDITY: Leghe con liquidità accettabile su Betfair/Betflag
const MEDIUM_LIQUIDITY_LEAGUES = [
    'EU-ENG Championship',
    'EU-NED Eredivisie',
    'EU-POR Primeira Liga',
    'EU-BEL Jupier Pro League',
    'EU-TUR Super Lig',
    'EU-GRE Super League',
    // Aggiunte per maggiore copertura
    'EU-SCO Premiership',
    'EU-AUT Bundesliga',
    'EU-SUI Super League',
    'EU-DEN Superliga',
    'EU-NOR Eliteserien',
    'EU-SWE Allsvenskan',
    'EU-CZE First League',
    'EU-POL Ekstraklasa',
    'EU-ROU Liga 1',
    'EU-CRO HNL',
    'EU-SRB SuperLiga',
    'EU-UKR Premier League',
    'EU-RUS Premier League',
    // Coppe europee minori
    'Europe UEFA Conference League',
    // Serie inferiori UK (buona liquidità comunque)
    'EU-ENG League One',
    'EU-ENG League Two',
    'EU-SCO Championship'
];

/**
 * Check league liquidity rating for Italian exchanges
 * @param {string} league - League name (e.g., 'EU-ITA Serie A')
 * @returns {object} { rating: 'ALTA'|'MEDIA'|'BASSA', badge: emoji, skip: boolean }
 */
function checkLiquidity(league) {
    if (HIGH_LIQUIDITY_LEAGUES.includes(league)) {
        return { rating: 'ALTA', badge: '✅', skip: false };
    } else if (MEDIUM_LIQUIDITY_LEAGUES.includes(league)) {
        return { rating: 'MEDIA', badge: '⚠️', skip: false };
    } else {
        // LOW liquidity - skip for trading (betting only)
        // console.log(`[LIQUIDITY] ❌ SKIP (low liquidity): "${league}"`);
        return { rating: 'BASSA', badge: '❌', skip: true };
    }
}

function createBackOver25Strategy(match, htProb, allMatches) {
    // ==================== LIQUIDITY CHECK ====================
    const liquidity = checkLiquidity(match.lega);
    if (liquidity.skip) {
        // console.log(`[OVER 2.5 DEBUG] ❌ SKIPPED due to LOW liquidity: ${match.partita}`);
        return null; // Skip low liquidity leagues for trading
    }
    // =========================================================

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

    // Analisi squadre se possibile
    if (teams.length === 2) {
        const homeStats = analyzeTeamStats(teams[0].trim(), true, '+2.5', allMatches);
        const awayStats = analyzeTeamStats(teams[1].trim(), false, '+2.5', allMatches);

        if (homeStats && awayStats && homeStats.total >= 5 && awayStats.total >= 5) {
            const homeOver25Rate = (homeStats.count / homeStats.total) * 100;
            const awayOver25Rate = (awayStats.count / awayStats.total) * 100;
            const avgRate = (homeOver25Rate + awayOver25Rate) / 2;

            if (avgRate >= 70) {
                reasoning.push(`squadre molto prolifiche (media Over 2.5: ${avgRate.toFixed(0)}%)`);
            } else if (avgRate >= 60) {
                reasoning.push(`buona prolificità squadre (${avgRate.toFixed(0)}% Over 2.5)`);
            }
        }
    }

    // Dettaglio lega se rilevante
    const legaNorm = normalizeLega(match.lega).toLowerCase();
    if (legaNorm.includes('premier') || legaNorm.includes('bundesliga')) {
        reasoning.push('campionato ad alto tasso gol');
    }

    return {
        ...match,
        _originalTip: match.tip,
        _originalQuota: match.quota,
        strategy: 'BACK_OVER_25',
        tradingInstruction: {
            action: 'Back Over 2.5',
            entryRange: entryRange,
            exitTarget: '1.50-1.70 dopo 1° gol',
            timing: 'Pre-match'
        },
        confidence: Math.min(95, match.score + 5),
        reasoning: reasoning.join(' + ') + ` | Liquidità: ${liquidity.rating} ${liquidity.badge}`,
        badge: {
            text: 'Trading Back Over 2.5',
            color: 'bg-purple-100 text-purple-700 border-purple-300'
        }
    };
}

// Helper: Crea strategia HT SNIPER (0.5 HT Live)
function createHTSniperStrategy(match, htProb) {
    const liquidity = checkLiquidity(match.lega);
    if (liquidity.skip) return null;

    return {
        ...match,
        strategy: 'HT_SNIPER',
        tradingInstruction: {
            action: 'Back Over 0.5 HT',
            entryRange: ['1.50', '2.00'],
            exitTarget: 'Immediato dopo gol nel 1°T',
            timing: 'Entrare al minuto 15-20 se ancora 0-0'
        },
        confidence: Math.round(htProb),
        reasoning: `ALTA PROBABILITÀ GOL 1°T (${htProb}%). Se 0-0 al minuto 20, la quota diventa di estremo valore. | Liquidità: ${liquidity.rating} ${liquidity.badge}`,
        badge: {
            text: '🎯 HT SNIPER',
            color: 'bg-red-600 text-white border-red-700 shadow-sm animate-pulse'
        }
    };
}

// Helper: Crea strategia SECOND HALF SURGE (0.5 ST)
function createSecondHalfSurgeStrategy(match, allMatches) {
    const liquidity = checkLiquidity(match.lega);
    if (liquidity.skip) return null;

    return {
        ...match,
        strategy: 'SECOND_HALF_SURGE',
        tradingInstruction: {
            action: 'Back Over 0.5 ST',
            entryRange: ['1.60', '2.10'],
            exitTarget: 'Gol nel secondo tempo',
            timing: 'Entrare al minuto 60-65 se partita bloccata'
        },
        confidence: Math.min(95, (match.score || 70) + 5),
        reasoning: `Match ad alta intensità statistica. Ottimo per sfruttare il calo delle quote nel secondo tempo tra il minuto 60 e 80. | Liquidità: ${liquidity.rating} ${liquidity.badge}`,
        badge: {
            text: '🔥 2ND HALF SURGE',
            color: 'bg-orange-600 text-white border-orange-700 shadow-sm'
        }
    };
}

// Helper: Crea strategia UNDER 3.5 TRADING (Scalping)
function createUnder35TradingStrategy(match) {
    const liquidity = checkLiquidity(match.lega);
    if (liquidity.skip) return null;

    return {
        ...match,
        strategy: 'UNDER_35_SCALPING',
        tradingInstruction: {
            action: 'Back Under 3.5 / Lay Over 3.5',
            entryRange: ['1.30', '1.60'],
            exitTarget: 'Scalping 10-15 tick o dopo 20 min',
            timing: 'Pre-match o primi 5 min'
        },
        confidence: Math.round(100 - (match.probabilita / 1.5)), // Inversa della probabilità over
        reasoning: `Match previsto "chiuso" con basso volume di tiri. Ideale per scaricare il rischio dopo i primi 15-20 minuti. | Liquidità: ${liquidity.rating} ${liquidity.badge}`,
        badge: {
            text: '🛡️ UNDER SCALPING',
            color: 'bg-emerald-600 text-white border-emerald-700 shadow-sm'
        }
    };
}

// Funzione principale: Trasforma partita in strategia trading
function transformToTradingStrategy(match, allMatches) {
    // 1. Dati base
    const tip = match.tip;
    const quota = match.quota;
    const prob = match.probabilita;
    const htProb = extractHTProb(match.info_ht);

    // 2. MAGIA AI CHECK (New Elite Trigger)
    // Usiamo il motore Magia AI per validare o generare il segnale
    const magicData = match.magicStats;

    // CASO 1: Over 1.5 MOLTO probabile (quota bassa) → BACK OVER 2.5
    if (tip === '+1.5' && quota <= 1.30 && prob >= 75) {
        return createBackOver25Strategy(match, htProb, allMatches);
    }

    // CASO 2: Over 2.5 diretto con alta probabilità
    if (tip === '+2.5' && (prob >= 65 || (magicData && magicData.over25Prob >= 60 && match.score >= 60))) {
        return createBackOver25Strategy(match, htProb, allMatches);
    }

    // CASO HT SNIPER: Molto probabile gol nel primo tempo
    if (htProb >= 80) {
        return createHTSniperStrategy(match, htProb);
    }

    // CASO 2ND HALF SURGE: Match da Over con probabilità medio-alta
    if (prob >= 60 && prob < 75 && match.score >= 60) {
        return createSecondHalfSurgeStrategy(match, allMatches);
    }

    // CASO UNDER 3.5 SCALPING: Match molto "chiusi" (es. -2.5 con prob > 70%)
    if (tip === '-2.5' && prob >= 70) {
        return createUnder35TradingStrategy(match);
    }

    // CASO 3 (HYBRID): LAY THE DRAW basato su Magia AI + Storico
    const teams = match.partita.split(' - ');
    if (teams.length === 2) {
        const homeDrawRate = analyzeDrawRate(teams[0].trim(), allMatches);
        const awayDrawRate = analyzeDrawRate(teams[1].trim(), allMatches);
        const avgRate = (homeDrawRate.rate + awayDrawRate.rate) / 2;

        // Trigger 1: Magia AI Elite (Pareggio improbabile Dixon-Coles)
        const aiLowDraw = magicData && magicData.drawProb < 20;

        // Trigger 2: Storico Solido (Tasso pareggi basso)
        const histLowDraw = avgRate < 24 && prob >= 75;

        if (aiLowDraw || histLowDraw) {
            // Se entrambi i sistemi concordano -> Diamond Signal
            const convergent = aiLowDraw && histLowDraw;
            return createLayTheDrawStrategy(match, avgRate, homeDrawRate, awayDrawRate, convergent);
        }
    }

    // Altrimenti SKIP
    return null;
}

function generateTradingBadge(match, is05HT = false, team1Stats = null, team2Stats = null) {
    const tip = (match.tip || '').trim().toUpperCase();
    const score = match.score || 0;

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
function simulateMatch(lambdaHome, lambdaAway, iterations = 5000, seedString = "") {
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
    const rho = DIXON_COLES_RHO || -0.11;

    for (let i = 0; i < iterations; i++) {
        const hg = poissonRandom(lambdaHome, rng);
        const ag = poissonRandom(lambdaAway, rng);

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
function generateMagiaAI(matches, allMatchesHistory) {
    const magicMatches = [];

    matches.forEach(match => {
        if (!match.lega) return;
        const teams = parseTeams(match.partita);
        if (!teams) return;

        const homeStats = analyzeTeamStats(teams.home, true, 'ALL', allMatchesHistory);
        const awayStats = analyzeTeamStats(teams.away, false, 'ALL', allMatchesHistory);

        if (homeStats.currForm.matchCount < 3 || awayStats.currForm.matchCount < 3) return;

        // League Goal Factor (Elite Upgrade)
        const leagueNorm = (match.lega || '').toLowerCase();
        let goalFactor = 1.0;
        for (const [l, factor] of Object.entries(LEAGUE_GOAL_FACTORS)) {
            if (leagueNorm.includes(l)) {
                goalFactor = factor;
                break;
            }
        }

        // 1. Prioritize Pre-Calculated Stats (Source of Truth)
        let sim;
        if (match.magicStats && match.magicStats.drawProb) {
            sim = {
                winHome: match.magicStats.winHomeProb,
                draw: match.magicStats.drawProb,
                winAway: match.magicStats.winAwayProb,
                dc1X: match.magicStats.winHomeProb + match.magicStats.drawProb,
                dcX2: match.magicStats.winAwayProb + match.magicStats.drawProb,
                dc12: match.magicStats.winHomeProb + match.magicStats.winAwayProb,
                // Restored Goal Probs
                over15: match.magicStats.over15Prob || 0,
                over25: match.magicStats.over25Prob || 0,
                under35: match.magicStats.under35Prob || 0,
                btts: match.magicStats.bttsProb || 0,
                noGol: match.magicStats.noGolProb || 0,

                mostFrequentScore: { score: "N/A", percent: 0 },
                exactScores: []
            };
            // Restore goal probs if available (should be added to pre-calc if needed)
        } else {
            // 2. Fallback Calculation (if running standalone)
            const lambdaHome = ((homeStats.currForm.avgScored * 0.6 + homeStats.season.avgScored * 0.4 +
                awayStats.currForm.avgConceded * 0.6 + awayStats.season.avgConceded * 0.4) / 2) * goalFactor;
            const lambdaAway = ((awayStats.currForm.avgScored * 0.6 + awayStats.season.avgScored * 0.4 +
                homeStats.currForm.avgConceded * 0.6 + homeStats.season.avgConceded * 0.4) / 2) * goalFactor;

            sim = simulateMatch(lambdaHome, lambdaAway, 5000, match.partita);

            // =====================================================================
            // HYBRID PROBABILITY REFINEMENT (User Feedback: "Draws are too high")
            // =====================================================================
            // Blend Simulation (70%) with Historical Draw Frequency (30%)
            const histHomeDraw = (homeStats.season.draws / homeStats.season.matches) * 100 || 25;
            const histAwayDraw = (awayStats.season.draws / awayStats.season.matches) * 100 || 25;
            const avgHistDraw = (histHomeDraw + histAwayDraw) / 2;

            // New Weighted Draw Probability
            let hybridDraw = (sim.draw * 0.7) + (avgHistDraw * 0.3);

            // Tipster Awareness: If Tip is "1" or "2", penalize Draw further
            // "considerare il calcolo precedente"
            const tip = (match.tip || '').trim();
            if (tip === '1' || tip === '2') {
                hybridDraw = hybridDraw * 0.90; // Reduce by 10%
            }

            // Normalize back to 100%
            const remainder = 100 - hybridDraw;
            const ratio = remainder / (sim.winHome + sim.winAway);
            sim.draw = hybridDraw;
            sim.winHome = sim.winHome * ratio;
            sim.winAway = sim.winAway * ratio;
            // Re-calc DCs
            sim.dc1X = sim.winHome + sim.draw;
            sim.dcX2 = sim.winAway + sim.draw;
            sim.dc12 = sim.winHome + sim.winAway;
            // =====================================================================
        }

        // MAP ALL SIGNALS (Translating to Italian)
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

        const bestSignal = allSignals[0];

        // 1. ELITE CONFIDENCE THRESHOLD
        // Dynamic threshold based on market type to ensure quality
        let threshold = 85;
        if (['DC', 'GOALS'].includes(bestSignal.type)) {
            // Demanda più certezza per mercati "facili" come Doppia Chance o Over 1.5
            if (bestSignal.label.includes('1.5') || bestSignal.label.includes('Duplicate')) threshold = 90; // Over 1.5 requires 90%
            if (bestSignal.type === 'DC') threshold = 88; // DC requires 88%
        }

        if (bestSignal.prob < threshold) return;

        // 2. VETO LOGIC: If AI says UNDER but DB Tip says OVER (or vice versa), SKIP.
        const dbTip = (match.tip || '').trim();
        if (dbTip.startsWith('+') && bestSignal.label.startsWith('Under')) return;
        if (dbTip.startsWith('-') && bestSignal.label.startsWith('Over')) return;

        // 3. ODDS FLOOR (1.20)
        const matchQuota = parseFloat(String(match.quota).replace(',', '.'));
        if (!isNaN(matchQuota) && matchQuota < 1.20) return;

        // 4. STRUCTURE DATA (FLATTENED)
        magicMatches.push({
            ...match,
            magicStats: {
                // Headlines
                exactScore: sim.mostFrequentScore.score,
                exactScorePerc: sim.mostFrequentScore.percent,

                // Dedicated Magia AI Fields (Source of Truth for this strategy)
                tipMagiaAI: bestSignal.label,
                oddMagiaAI: match.quota, // Default to CSV odd, will be enriched in admin if API is available

                // Top Signals (The Professional Scanner view) - PURE STATISTICAL TOP 3
                topSignals: allSignals.slice(0, 3),
                aiSignal: bestSignal.label,
                confidence: bestSignal.prob,

                // Flattened Probabilities
                winHomeProb: sim.winHome,
                drawProb: sim.draw,
                winAwayProb: sim.winAway,
                over15Prob: sim.over15,
                over25Prob: sim.over25,
                under35Prob: sim.under35,
                bttsProb: sim.btts,
                noGolProb: sim.noGol,
                dc1XProb: sim.dc1X,
                dcX2Prob: sim.dcX2,
                dc12Prob: sim.dc12,

                // Metadata
                safetyLevel: calculateSafetyLevel(sim),
                topScores: sim.exactScores.filter(s => s.percent >= 12).slice(0, 3)
            },
            score: bestSignal.prob // Sorting
        });
    });

    return magicMatches.sort((a, b) => b.score - a.score);
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

    // League Goal Factor
    const leagueNorm = (match.lega || '').toLowerCase();
    let goalFactor = 1.0;
    for (const [l, factor] of Object.entries(LEAGUE_GOAL_FACTORS)) {
        if (leagueNorm.includes(l)) {
            goalFactor = factor;
            break;
        }
    }

    const lambdaHome = ((homeStats.currForm.avgScored * 0.6 + homeStats.season.avgScored * 0.4 +
        awayStats.currForm.avgConceded * 0.6 + awayStats.season.avgConceded * 0.4) / 2) * goalFactor;
    const lambdaAway = ((awayStats.currForm.avgScored * 0.6 + awayStats.season.avgScored * 0.4 +
        homeStats.currForm.avgConceded * 0.6 + homeStats.season.avgConceded * 0.4) / 2) * goalFactor;

    const sim = simulateMatch(lambdaHome, lambdaAway, 5000, match.partita);

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
        drawProb: sim.draw,
        winHomeProb: sim.winHome,
        winAwayProb: sim.winAway,
        over25Prob: sim.over25,
        aiSignal: allSignals[0].label,
        confidence: allSignals[0].prob
    };
}

const parseTeams = (partita) => {
    const parts = partita.split(' - ');
    if (parts.length < 2) return null;
    return { home: parts[0].trim(), away: parts[1].trim() };
};

// Export functions
window.calculateStrategyRankings = null; // Will be defined in admin logic, not here
window.engine = {
    poissonProbability: null, // Removed simple Poisson, replaced by Monte Carlo
    analyzeTeamStats,
    calculateScore,
    generateTradingBadge,
    checkLiquidity,
    simulateMatch,
    getMagiaStats,
    generateMagiaAI
};
