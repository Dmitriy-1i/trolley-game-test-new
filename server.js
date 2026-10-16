const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { maxHttpBufferSize: 1e5 });
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

const MIN_PLAYERS = 3;
const ROUND_TIME = 20000;      // время на выбор стрелочника
const TROLLEY_TIME = 4200;     // сколько едет трамвай до следующего раунда
const START_DELAY = 1500;      // пауза перед первым раундом
const MAX_FRAME_SIZE = 60000;  // ограничение на размер кадра с камеры

// Игроки в лобби/игре по порядку входа: { id, name }
let players = [];
let gameStarted = false;
let isTrolleyMoving = false;
let currentConductorIndex = -1;
let currentRound = null;
let roundNumber = 0;
let nextRoundTimeout = null;
let choiceTimeout = null;

const isPlayer = (id) => players.some(p => p.id === id);

function cleanName(name, fallback) {
    const s = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    return s || fallback;
}

function broadcastLobby() {
    io.to('players').emit('lobbyUpdate', {
        players,
        minPlayers: MIN_PLAYERS,
        gameStarted
    });
}

function clearTimers() {
    clearTimeout(nextRoundTimeout);
    clearTimeout(choiceTimeout);
    nextRoundTimeout = null;
    choiceTimeout = null;
}

function stopGame(reason) {
    clearTimers();
    gameStarted = false;
    isTrolleyMoving = false;
    currentRound = null;
    currentConductorIndex = -1;
    roundNumber = 0;
    io.to('players').emit('gameStopped', { reason });
    broadcastLobby();
}

io.on('connection', (socket) => {
    console.log(`Подключение: ${socket.id}`);

    socket.on('joinLobby', (data) => {
        const name = cleanName(data && data.name, `Игрок ${players.length + 1}`);
        const existing = players.find(p => p.id === socket.id);
        if (existing) {
            existing.name = name;
        } else {
            players.push({ id: socket.id, name });
            socket.join('players');
        }
        console.log(`${name} в лобби. Всего: ${players.length}`);
        broadcastLobby();

        // Игра уже идёт — подключаем зрителем до следующего раунда
        if (gameStarted) {
            socket.emit('startGame');
            if (currentRound) socket.emit('newRound', roundPayloadFor(currentRound));
        }
    });

    socket.on('leaveLobby', () => removePlayer(socket));

    socket.on('startGameRequest', () => {
        if (gameStarted || !isPlayer(socket.id) || players.length < MIN_PLAYERS) return;
        console.log('Игра запущена');
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
        if (!isPlayer(socket.id)) return;
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
    players.splice(idx, 1);
    socket.leave('players');
    io.to('players').emit('playerLeft', { id: socket.id });

    if (!gameStarted) {
        broadcastLobby();
        return;
    }

    if (players.length < MIN_PLAYERS) {
        stopGame('Недостаточно игроков — ждём новых участников');
        return;
    }

    // Сохраняем очередь стрелочников после удаления
    if (idx <= currentConductorIndex) currentConductorIndex--;
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
    console.log(`Трамвай поехал по пути ${track}${auto ? ' (время вышло)' : ''}`);
    io.to('players').emit('trolleyMoveRemote', { track, auto, victims });
    nextRoundTimeout = setTimeout(startNewRound, TROLLEY_TIME);
}

function roundPayloadFor(round) {
    return { ...round, timeLeft: Math.max(0, round.deadline - Date.now()) };
}

function startNewRound() {
    clearTimers();
    if (!gameStarted) return;
    if (players.length < MIN_PLAYERS) {
        stopGame('Недостаточно игроков — ждём новых участников');
        return;
    }

    const N = players.length;
    currentConductorIndex = (currentConductorIndex + 1 + N) % N;
    const conductorId = players[currentConductorIndex].id;

    // Остальных раскладываем по двум путям поочерёдно
    const trackA = [];
    const trackB = [];
    for (let i = 1; i < N; i++) {
        const victimId = players[(currentConductorIndex + i) % N].id;
        (i % 2 === 1 ? trackA : trackB).push(victimId);
    }

    roundNumber++;
    isTrolleyMoving = false;
    currentRound = {
        round: roundNumber,
        conductorId,
        trackA,
        trackB,
        names: Object.fromEntries(players.map(p => [p.id, p.name])),
        deadline: Date.now() + ROUND_TIME
    };

    io.to('players').emit('newRound', roundPayloadFor(currentRound));

    // Стрелочник не успел — путь выбирается случайно
    choiceTimeout = setTimeout(() => {
        if (currentRound && !isTrolleyMoving) {
            launchTrolley(Math.random() < 0.5 ? 'A' : 'B', true);
        }
    }, ROUND_TIME);

    console.log(`=== РАУНД ${roundNumber} ===`);
    console.log(`Стрелочник: ${players[currentConductorIndex].name}`);
    console.log(`Путь А: ${trackA.length} чел. | Путь Б: ${trackB.length} чел.`);
}

const PORT = process.env.PORT || 3000;

http.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
