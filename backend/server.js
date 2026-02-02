const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ADDED: db pool and make it available to routes
const db = require('./db'); // <- new file: db.js
app.locals.db = db; // <- make pool accessible via req.app.locals.db

// Routes
const authRoutes = require('./routes/auth');
const batchRoutes = require('./routes/batches');
const teacherRoutes = require('./routes/teachers');
const studentRoutes = require('./routes/students');
// removed: const settingsRoutes = require('./settings');  <-- this caused MODULE_NOT_FOUND

// mount auth first (clearer)
app.use('/api/auth', authRoutes);

// app routes
app.use('/api/batches', batchRoutes);
app.use('/api/teachers', teacherRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/marks', require('./routes/marks'));
app.use('/api/settings', require('./routes/settings')); 
app.use('/api/assignments', require('./routes/assignments'));

// serve uploaded files
const path = require("path");
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"))
);

// Health check endpoint for system status strip
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    time: Date.now()
  });
});


// basic 404
app.use((req, res) => res.status(404).json({ message: 'Not found' }));

// optional error handler (nice to have)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
