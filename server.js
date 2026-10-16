const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let players = [];
let isTrolleyMoving = false;
let currentConductorIndex = -1;
let firstRoundTriggered = false;
let roundTimeout = null;

io.on('connection', (socket) => {
    players.push(socket.id);
    console.log(`Игрок подключился: ${socket.id}. Всего: ${players.length}`);

    io.emit('lobbyUpdate', { count: players.length, players: players });

    socket.on('playerJoinLobby', () => {
        io.emit('lobbyUpdate', { count: players.length, players: players });
    });

    socket.on('startGameRequest', () => {
        if (players.length >= 3) {
            console.log("Игра запущена по запросу игрока!");
            currentConductorIndex = -1;
            firstRoundTriggered = false;
            io.emit('startGame');
        }
    });

    // Защищённый запуск первого раунда
    socket.on('requestFirstRound', () => {
        if (players.length >= 3 && !firstRoundTriggered) {
            console.log("Первый раунд запущен (по запросу клиента)");
            firstRoundTriggered = true;
            startNewRound();
        } else if (firstRoundTriggered) {
            console.log("Первый раунд уже был запущен — игнорируем повторный запрос");
        }
    });

    socket.on('trolleyGo', (data) => {
        if (isTrolleyMoving) return;
        isTrolleyMoving = true;

        console.log(`Трамвай поехал! Ждем 4.2 сек до нового раунда...`);
        io.emit('trolleyMoveRemote', data);

        // Сохраняем таймер
        roundTimeout = setTimeout(() => {
            startNewRound();
        }, 4200);
    });

    socket.on('streamFrame', (frame) => {
        if (typeof frame !== 'string') return;
        io.emit('playerFrame', { id: socket.id, frame: frame });
    });

    socket.on('disconnect', () => {
        players = players.filter(id => id !== socket.id);
        console.log(`Игрок отключился: ${socket.id}. Осталось: ${players.length}`);
        if (players.length >= 3) {
            startNewRound();
        }
    });
});

function startNewRound() {
    if (players.length < 3) {
        console.log("Недостаточно игроков для старта раунда.");
        return;
    }

    if (roundTimeout) {
        clearTimeout(roundTimeout);
        roundTimeout = null;
    }

    const N = players.length;
    currentConductorIndex = (currentConductorIndex + 1) % N;
    const conductorId = players[currentConductorIndex];

    // Собираем жертв и сразу делим на два пути
    let trackA = [];
    let trackB = [];

    let victimCount = 0;
    for (let i = 1; i < N; i++) {
        const victimId = players[(currentConductorIndex + i) % N];
        // Четных кидаем на путь А, нечетных на путь Б
        if (victimCount % 2 === 0) {
            trackA.push(victimId);
        } else {
            trackB.push(victimId);
        }
        victimCount++;
    }

    const payload = {
        conductorId: conductorId,
        trackA: trackA,
        trackB: trackB
    };

    io.emit('newRound', payload);
    io.emit('resetTrolleyVisual');

    isTrolleyMoving = false;

    console.log('=== НОВЫЙ РАУНД ===');
    console.log(`Стрелочник: ${conductorId}`);
    console.log(`Путь А: ${trackA.length} чел. | Путь Б: ${trackB.length} чел.`);
}

const PORT = process.env.PORT || 3000;

http.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});