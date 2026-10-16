const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { maxHttpBufferSize: 1e5 });
const path = require('path');
const { buildDeck, shuffle } = require('./cards');

app.use(express.static(path.join(__dirname, 'public')));

const MIN_PLAYERS = 3;
const MAX_TOKENS = 5;          // столько жетонов смерти — и игрок выбывает
const ROUND_TIME = 30000;      // время на уговоры и выбор стрелочника
const SABOTAGE_TIME = 10000;   // время на выбор после карты «Саботаж»
const REVEAL_BASE = 2200;      // раскрытие карт: база + шаг на каждую карту
const REVEAL_STEP = 450;
const TROLLEY_TIME = 4200;     // сколько едет трамвай до следующего раунда
const ELIMINATION_PAUSE = 1800; // дополнительная пауза, если кто-то выбыл
const START_DELAY = 1500;      // пауза перед первым раундом
const MAX_FRAME_SIZE = 60000;  // ограничение на размер кадра с камеры

// Игроки по порядку входа: { id, name, tokens, status }
// status: 'active' — в игре, 'out' — выбыл, 'waiting' — ждёт следующей игры
let players = [];
let gameStarted = false;
let isTrolleyMoving = false;
let currentConductorIndex = -1;
let currentRound = null;
let roundNumber = 0;
let nextRoundTimeout = null;
let choiceTimeout = null;
let drawPile = [];
let discardPile = [];

const findPlayer = (id) => players.find(p => p.id === id);
const activePlayers = () => players.filter(p => p.status === 'active');
const publicPlayers = () => players.map(({ id, name, tokens, status }) => ({ id, name, tokens, status }));

function cleanName(name, fallback) {
    const s = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    return s || fallback;
}

function broadcastLobby() {
    io.to('players').emit('lobbyUpdate', {
        players: publicPlayers(),
        minPlayers: MIN_PLAYERS,
        maxTokens: MAX_TOKENS,
        gameStarted
    });
}

function clearTimers() {
    clearTimeout(nextRoundTimeout);
    clearTimeout(choiceTimeout);
    nextRoundTimeout = null;
    choiceTimeout = null;
}

function roundPayload() {
    const now = Date.now();
    return {
        ...currentRound,
        players: publicPlayers(),
        maxTokens: MAX_TOKENS,
        revealLeft: Math.max(0, currentRound.revealEnd - now),
        timeLeft: Math.max(0, currentRound.deadline - now)
    };
}

function drawCard() {
    if (!drawPile.length) {
        drawPile = shuffle(discardPile.length ? discardPile : buildDeck());
        discardPile = [];
    }
    return drawPile.pop();
}

io.on('connection', (socket) => {
    console.log(`Подключение: ${socket.id}`);

    socket.on('joinLobby', (data) => {
        const name = cleanName(data && data.name, `Игрок ${players.length + 1}`);
        const existing = findPlayer(socket.id);
        if (existing) {
            existing.name = name;
        } else {
            players.push({ id: socket.id, name, tokens: 0, status: gameStarted ? 'waiting' : 'active' });
            socket.join('players');
        }
        console.log(`${name} в лобби. Всего: ${players.length}`);
        broadcastLobby();

        // Игра уже идёт — показываем её, а играть можно со следующей
        if (gameStarted) {
            socket.emit('startGame');
            if (currentRound) socket.emit('newRound', roundPayload());
        }
    });

    socket.on('leaveLobby', () => removePlayer(socket));

    socket.on('startGameRequest', () => {
        if (gameStarted || !findPlayer(socket.id) || players.length < MIN_PLAYERS) return;
        console.log('Игра запущена');
        players.forEach(p => { p.tokens = 0; p.status = 'active'; });
        drawPile = shuffle(buildDeck());
        discardPile = [];
        gameStarted = true;
        currentConductorIndex = -1;
        roundNumber = 0;
        io.to('players').emit('startGame');
        broadcastLobby();
        nextRoundTimeout = setTimeout(startNewRound, START_DELAY);
    });

    socket.on('trolleyGo', (data) => {
        const track = data && data.track;
        if (!currentRound || isTrolleyMoving) return;
        if (socket.id !== currentRound.conductorId) return;
        if (Date.now() < currentRound.revealEnd) return;
        if (track !== 'A' && track !== 'B') return;
        launchTrolley(track, false);
    });

    socket.on('streamFrame', (frame) => {
        if (typeof frame !== 'string' || frame.length > MAX_FRAME_SIZE) return;
        if (!frame.startsWith('data:image/jpeg')) return;
        if (!findPlayer(socket.id)) return;
        io.to('players').volatile.emit('playerFrame', { id: socket.id, frame });
    });

    socket.on('disconnect', () => {
        console.log(`Отключение: ${socket.id}`);
        removePlayer(socket);
    });
});

function removePlayer(socket) {
    const idx = players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    const [removed] = players.splice(idx, 1);
    socket.leave('players');
    io.to('players').emit('playerLeft', { id: socket.id });

    if (!gameStarted) {
        broadcastLobby();
        return;
    }

    // Сохраняем очередь стрелочников после удаления
    if (idx <= currentConductorIndex) currentConductorIndex--;

    if (removed.status === 'active' && activePlayers().length < MIN_PLAYERS) {
        finishGame('Слишком много игроков вышло');
        return;
    }
    broadcastLobby();

    // Ушёл стрелочник до выбора — сразу новый раунд
    if (currentRound && currentRound.conductorId === socket.id && !isTrolleyMoving) {
        startNewRound();
    }
}

function launchTrolley(track, auto) {
    isTrolleyMoving = true;
    clearTimeout(choiceTimeout);
    choiceTimeout = null;

    const victims = track === 'A' ? currentRound.trackA : currentRound.trackB;
    const eliminated = [];
    // Жетон получает каждый игрок проигравшей стороны (кроме тех, кто в бронежилете)
    victims.forEach(id => {
        const p = findPlayer(id);
        if (!p || p.status !== 'active') return;
        if (currentRound.immune.includes(id)) return;
        p.tokens = Math.min(MAX_TOKENS, p.tokens + currentRound.multiplier);
        if (p.tokens >= MAX_TOKENS) {
            p.status = 'out';
            eliminated.push(id);
        }
    });

    console.log(`Трамвай поехал по пути ${track}${auto ? ' (время вышло)' : ''}`);
    io.to('players').emit('trolleyMoveRemote', {
        track,
        auto,
        victims,
        immune: currentRound.immune,
        multiplier: currentRound.multiplier,
        eliminated,
        players: publicPlayers(),
        maxTokens: MAX_TOKENS
    });
    nextRoundTimeout = setTimeout(startNewRound, TROLLEY_TIME + (eliminated.length ? ELIMINATION_PAUSE : 0));
}

function finishGame(reason) {
    clearTimers();
    const ranked = players
        .filter(p => p.status !== 'waiting')
        .sort((a, b) => (a.status === 'out') - (b.status === 'out') || a.tokens - b.tokens);
    const best = ranked[0];
    const winners = best
        ? ranked.filter(p => p.status === best.status && p.tokens === best.tokens).map(p => p.id)
        : [];

    console.log(`Игра окончена: ${reason}`);
    io.to('players').emit('gameOver', {
        reason,
        winners,
        standings: ranked.map(({ id, name, tokens, status }) => ({ id, name, tokens, status })),
        maxTokens: MAX_TOKENS
    });

    gameStarted = false;
    isTrolleyMoving = false;
    currentRound = null;
    currentConductorIndex = -1;
    roundNumber = 0;
    players.forEach(p => { p.status = 'active'; });
    broadcastLobby();
}

function startNewRound() {
    clearTimers();
    if (!gameStarted) return;

    const active = activePlayers();
    if (active.length < MIN_PLAYERS) {
        finishGame(active.length === 1 ? 'Остался последний выживший' : 'Выживших слишком мало для нового раунда');
        return;
    }

    // Следующий стрелочник — следующий по кругу активный игрок
    const N = players.length;
    let conductorIdx = -1;
    for (let k = 1; k <= N; k++) {
        const i = (((currentConductorIndex + k) % N) + N) % N;
        if (players[i].status === 'active') { conductorIdx = i; break; }
    }
    currentConductorIndex = conductorIdx;
    const conductorId = players[conductorIdx].id;

    // Остальных активных раскладываем по двум путям поочерёдно
    const tracks = { A: [], B: [] };
    let n = 0;
    for (let k = 1; k < N; k++) {
        const p = players[(conductorIdx + k) % N];
        if (p.status !== 'active') continue;
        tracks[n % 2 === 0 ? 'A' : 'B'].push(p.id);
        n++;
    }

    // Прошлые карты уходят в сброс
    if (currentRound) discardPile.push(...currentRound.cardsA, ...currentRound.cardsB, ...currentRound.actionCards);

    // Каждый игрок на путях тянет одну карту и раскрывает её
    const other = (t) => (t === 'A' ? 'B' : 'A');
    const cards = { A: [], B: [] };
    const actionCards = [];
    const draws = [];
    const immune = [];
    let multiplier = 1;
    let roundTime = ROUND_TIME;
    [...tracks.A.map(id => [id, 'A']), ...tracks.B.map(id => [id, 'B'])]
        .sort(() => Math.random() - 0.5)
        .forEach(([id]) => {
            const own = tracks.A.includes(id) ? 'A' : 'B';
            const card = drawCard();
            const draw = { playerId: id, card, track: own };
            if (card.type === 'innocent') {
                cards[own].push(card);
                draw.to = own;
            } else if (card.type === 'villain') {
                cards[other(own)].push(card);
                draw.to = other(own);
            } else {
                actionCards.push(card);
                const p = findPlayer(id);
                if (card.action === 'shield') immune.push(id);
                if (card.action === 'defector') {
                    tracks[own] = tracks[own].filter(x => x !== id);
                    tracks[other(own)].push(id);
                    draw.to = other(own);
                }
                if (card.action === 'medkit') p.tokens = Math.max(0, p.tokens - 1);
                if (card.action === 'sabotage') roundTime = SABOTAGE_TIME;
                if (card.action === 'double') multiplier = 2;
            }
            draws.push(draw);
        });

    const now = Date.now();
    const revealMs = REVEAL_BASE + draws.length * REVEAL_STEP;
    roundNumber++;
    isTrolleyMoving = false;
    currentRound = {
        round: roundNumber,
        conductorId,
        trackA: tracks.A,
        trackB: tracks.B,
        cardsA: cards.A,
        cardsB: cards.B,
        actionCards,
        draws,
        immune,
        multiplier,
        roundTime,
        revealEnd: now + revealMs,
        deadline: now + revealMs + roundTime
    };

    io.to('players').emit('newRound', roundPayload());

    // Стрелочник не успел — путь выбирается случайно
    choiceTimeout = setTimeout(() => {
        if (currentRound && !isTrolleyMoving) {
            launchTrolley(Math.random() < 0.5 ? 'A' : 'B', true);
        }
    }, currentRound.deadline - now);

    console.log(`=== РАУНД ${roundNumber} ===`);
    console.log(`Стрелочник: ${players[conductorIdx].name}`);
    console.log(`Путь А: ${tracks.A.length} чел. | Путь Б: ${tracks.B.length} чел.`);
    draws.forEach(d => console.log(`  ${findPlayer(d.playerId).name}: ${d.card.title}`));
}

const PORT = process.env.PORT || 3000;

http.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
