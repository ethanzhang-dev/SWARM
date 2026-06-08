const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// role counter — lives on the server, no race conditions
let roleCounter = 0;

io.on('connection', (socket) => {
  console.log('device connected:', socket.id);

  // assign role immediately on connection
  const assignedRole = roleCounter % 5;
  roleCounter++;
  socket.emit('roleAssigned', { role: assignedRole });
  console.log('assigned role', assignedRole, 'to', socket.id);

  socket.on('shake', (data) => {
    socket.broadcast.emit('shake', data);
  });

  socket.on('disconnect', () => {
    console.log('device disconnected:', socket.id);
  });
});

// health check — keeps Render free tier alive
app.get('/health', (req, res) => res.send('ok'));

if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {});
  }, 14 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SWARM server running on port ${PORT}`);
});
