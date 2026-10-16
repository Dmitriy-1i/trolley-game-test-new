const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { maxHttpBufferSize: 1e5 });
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

const MIN_PLAYERS = 3;
const MAX_TOKENS = 5;          // столько жетонов смерти — и игрок выбывает
const ROUND_TIME = 20000;      // время на выбор стрелочника
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
    return {
        ...currentRound,
        players: publicPlayers(),
        maxTokens: MAX_TOKENS,
        timeLeft: Math.max(0, currentRound.deadline - Date.now())
    };
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
    victims.forEach(id => {
        const p = findPlayer(id);
        if (!p || p.status !== 'active') return;
        p.tokens++;
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
    const trackA = [];
    const trackB = [];
    let n = 0;
    for (let k = 1; k < N; k++) {
        const p = players[(conductorIdx + k) % N];
        if (p.status !== 'active') continue;
        (n % 2 === 0 ? trackA : trackB).push(p.id);
        n++;
    }

    roundNumber++;
    isTrolleyMoving = false;
    currentRound = {
        round: roundNumber,
        conductorId,
        trackA,
        trackB,
        deadline: Date.now() + ROUND_TIME
    };

    io.to('players').emit('newRound', roundPayload());

    // Стрелочник не успел — путь выбирается случайно
    choiceTimeout = setTimeout(() => {
        if (currentRound && !isTrolleyMoving) {
            launchTrolley(Math.random() < 0.5 ? 'A' : 'B', true);
        }
    }, ROUND_TIME);

    console.log(`=== РАУНД ${roundNumber} ===`);
    console.log(`Стрелочник: ${players[conductorIdx].name}`);
    console.log(`Путь А: ${trackA.length} чел. | Путь Б: ${trackB.length} чел.`);
}

const PORT = process.env.PORT || 3000;

http.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
