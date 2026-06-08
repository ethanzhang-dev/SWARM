// SWARM — relay server
// receives shake data from phones and broadcasts it to the host computer
// phones and the host computer connect through Socket.io
const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');
const app    = express();
const server = http.createServer(app);
// serve the phone interface from the public folder
app.use(express.static(path.join(__dirname, 'public')));
// allow all origins so the p5 Web Editor can connect
const io = new Server(server, {
  cors: {
    origin:  "*",
    methods: ["GET", "POST"]
  }
});
// when a device connects (phone or host computer)
io.on('connection', (socket) => {
  console.log('device connected:', socket.id);
  // receive shake data from a phone and broadcast to everyone else
  socket.on('shake', (data) => {
    socket.broadcast.emit('shake', data);
  });
  // device disconnected
  socket.on('disconnect', () => {
    console.log('device disconnected:', socket.id);
  });
});

// health check endpoint — keeps the server alive on Render free tier
app.get('/health', (req, res) => res.send('ok'));

if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL + '/health')
      .catch(() => {});
  }, 14 * 60 * 1000);
}

// Render assigns the port automatically via process.env.PORT
// default is 3000 for local testing
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SWARM server running on port ${PORT}`);
});
