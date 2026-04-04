const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// Говорим серверу, где лежат файлы игры
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

let players = [];
let currentPlayerIndex = 0;

io.on('connection', (socket) => {
    players.push(socket.id);
    console.log(`Игрок подключился: ${socket.id}. Всего: ${players.length}`);

    if (players.length >= 1) {
        nextRound();
    }

    // При подключении даем роль (первый зашедший — стрелочник)
    socket.on('playerReady', () => {
        const role = (players.indexOf(socket.id) === currentPlayerIndex) ? 'conductor' : 'player';
        socket.emit('initRole', { role: role });
    });

    // Внутри io.on('connection', ...)
    socket.on('streamFrame', (frame) => {
        socket.broadcast.emit('playerFrame', { id: socket.id, frame: frame });
    });

    socket.on('trolleyGo', (data) => {
        // 1. Рассылаем всем команду ехать
        io.emit('trolleyMoveRemote', data);

        // 2. Ждем, пока поезд проедет (например, 4 секунды)
        setTimeout(() => {
            // 3. Передаем ход следующему
            currentPlayerIndex = (currentPlayerIndex + 1) % players.length;

            // 4. Объявляем новый раунд всем игрокам
            io.emit('newRound', {
                conductorId: players[currentPlayerIndex],
            });

            // Возвращаем поезд в депо визуально
            io.emit('resetTrolleyVisual');
        }, 4000);
    });

    socket.on('disconnect', () => {
        players = players.filter(id => id !== socket.id);
        // Если вышел стрелочник, сбрасываем индекс, чтобы игра не зависла
        if (currentPlayerIndex >= players.length) currentPlayerIndex = 0;
    });

});

function nextRound() {
    console.log("--- Запуск нового раунда ---");
    console.log("Текущие игроки в массиве:", players);

    if (players.length === 0) {
        console.log("Ошибка: Массив игроков пуст!");
        return;
    }

    // Выбираем стрелочника
    currentPlayerIndex = (currentPlayerIndex + 1) % players.length;
    const cId = players[currentPlayerIndex];

    // Выбираем жертв (даже если игрок один, берем его же для теста)
    const vA = players[1] || players[0];
    const vB = players[2] || players[0];

    const payload = {
        conductorId: cId,
        victimA_Id: vA,
        victimB_Id: vB
    };

    io.emit('newRound', payload);
}

http.listen(3000, () => {
    console.log('Сервер запущен! Открой в браузере: http://localhost:3000');
});