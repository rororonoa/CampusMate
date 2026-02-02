// backend/routes/batches.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// GET /api/batches - list all batches
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, course, `batch`, `year`, created_at FROM batches ORDER BY course, `batch`, `year`');
    res.json(rows);
  } catch (err) {
    console.error('GET /api/batches', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/batches - create batch (admin only)
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
  const { course, batch, year } = req.body;
  if (!course || !batch) return res.status(400).json({ message: 'Course and batch required' });
  try {
    const [result] = await pool.query('INSERT INTO batches (course, `batch`, `year`) VALUES (?, ?, ?)', [course, batch, year || null]);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error('POST /api/batches', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/batches/:id/assign-teacher (admin only)
router.post('/:id/assign-teacher', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
  const batchId = req.params.id;
  const { teacher_id } = req.body;
  if (!teacher_id) return res.status(400).json({ message: 'teacher_id required' });
  try {
    await pool.query('INSERT IGNORE INTO teacher_batches (teacher_id, batch_id, assigned_by) VALUES (?, ?, ?)', [teacher_id, batchId, req.user.id]);
    res.json({ message: 'Assigned' });
  } catch (err) {
    console.error('POST /api/batches/:id/assign-teacher', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/batches/:id/unassign-teacher/:teacherId (admin only)
router.delete('/:id/unassign-teacher/:teacherId', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
  try {
    await pool.query('DELETE FROM teacher_batches WHERE teacher_id = ? AND batch_id = ?', [req.params.teacherId, req.params.id]);
    res.json({ message: 'Unassigned' });
  } catch (err) {
    console.error('DELETE /api/batches/:id/unassign-teacher/:teacherId', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
