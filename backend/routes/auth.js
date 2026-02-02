// backend/routes/auth.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

require('dotenv').config();

// Helper to create JWT
function createToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });
}

/**
 * Admin Login
 * POST /api/auth/admin/login
 * Body: { email, password }
 */
router.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM admins WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(400).json({ message: 'Invalid Email' });

    const admin = rows[0];
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(400).json({ message: 'Incorrect Password' });

    const token = createToken({ id: admin.id, role: 'admin', name: admin.name, email: admin.email });

    // return admin key (frontend already handles admin / teacher / user)
    res.json({
      token,
      admin: { id: admin.id, name: admin.name, email: admin.email }
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Teacher Login
 * POST /api/auth/teacher/login
 * Body: { email, password }
 *
 * Returns: { token, teacher: { id, name, email, subject } }
 */
router.post('/teacher/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM teachers WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(400).json({ message: 'Invalid Email' });

    const teacher = rows[0];
    const valid = await bcrypt.compare(password, teacher.password);
    if (!valid) return res.status(400).json({ message: 'Incorrect Password' });

    const token = createToken({ id: teacher.id, role: 'teacher', name: teacher.name, email: teacher.email });

      res.json({
        token,
        teacher: {
          id: teacher.id,
          name: teacher.name,
          email: teacher.email,
          subject: teacher.subject,
          specialization: teacher.specialization || null
      }
    });
  } catch (err) {
    console.error('Teacher login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * Student Login
 * POST /api/auth/student/login
 * Body: { email, password }
 */
router.post('/student/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password required' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT id, name, email, batch_id, semester, password
       FROM students
       WHERE email = ?`,
      [email]
    );

    if (!rows.length) {
      return res.status(400).json({ message: 'Invalid Email' });
    }

    const student = rows[0];
    const valid = await bcrypt.compare(password, student.password);

    if (!valid) {
      return res.status(400).json({ message: 'Incorrect Password' });
    }

    const token = createToken({
      id: student.id,
      role: 'student',
      batch_id: student.batch_id,
      semester: student.semester
    });

    res.json({
      token,
      student: {
        id: student.id,
        name: student.name,
        email: student.email,
        batch_id: student.batch_id,
        semester: student.semester
      }
    });
  } catch (err) {
    console.error('Student login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;