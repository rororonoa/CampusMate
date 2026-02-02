// backend/routes/attendance.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const auth = require('../middleware/auth');

function isAdmin(user){ return user && user.role === 'admin'; }
function isSelf(user, id){ return user && Number(user.id) === Number(id); }

// validate date format YYYY-MM-DD (simple)
function isValidDateString(d){
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(d).getTime());
}

// --- Helper: check teacher assigned to batch ---
async function teacherHasBatch(teacherId, batchId){
  const [rows] = await pool.query('SELECT 1 FROM teacher_batches WHERE teacher_id = ? AND batch_id = ? LIMIT 1', [teacherId, batchId]);
  return rows.length > 0;
}

router.get('/', auth, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Forbidden' });
    const date = req.query.date;
    const batchId = req.query.batch_id ? Number(req.query.batch_id) : null;

    if (!date || !isValidDateString(date)) return res.status(400).json({ message: 'date required' });

    const qParams = [date];
    let q = `
      SELECT a.student_id, a.attendance_date, a.status, a.recorded_by,
             s.roll_no, s.name, s.email, s.course, b.batch AS std, b.year AS batch_year
      FROM attendance a
      JOIN students s ON s.id = a.student_id
      LEFT JOIN batches b ON s.batch_id = b.id
      WHERE a.attendance_date = ?
    `;
    if (batchId) { q += ' AND s.batch_id = ?'; qParams.push(batchId); }

    q += ' ORDER BY s.roll_no';
    const [rows] = await pool.query(q, qParams);
    return res.json(rows);
  } catch (err) {
    console.error('GET /api/attendance', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/teachers/:id/attendance?date=YYYY-MM-DD&batch_id=...
router.get('/teachers/:id/attendance', auth, async (req, res) => {
  try {
    const tid = Number(req.params.id);
    const user = req.user;
    const date = req.query.date;
    const batchId = req.query.batch_id ? Number(req.query.batch_id) : null;

    if (!date || !isValidDateString(date)) return res.status(400).json({ message: 'Invalid date' });
    if (!batchId) return res.status(400).json({ message: 'batch_id required' });

    if (!isAdmin(user) && !isSelf(user, tid)) return res.status(403).json({ message: 'Forbidden' });
    if (!isAdmin(user)) {
      const ok = await teacherHasBatch(tid, batchId);
      if (!ok) return res.status(403).json({ message: 'Forbidden' });
    }

    // return attendance entries for the batch date (with student info)
    const [rows] = await pool.query(
      `SELECT a.student_id, a.status, a.recorded_by, s.roll_no, s.name, s.email, s.course
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       WHERE a.attendance_date = ? AND s.batch_id = ?
       ORDER BY ${ROLL_ORDER_SQL}`,
      [date, batchId]
    );
    return res.json(rows);
  } catch (err) {
    console.error('GET /teachers/:id/attendance', err);
    return res.status(500).json({ message: 'Server error' });
  }
});


// admin POST (bulk upsert) - reuse teacher logic but skip teacher check
router.post('/', auth, async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ message: 'Forbidden' });
    const { date, batch_id, records } = req.body || {};
    if (!date || !isValidDateString(date)) return res.status(400).json({ message: 'Validation failed', fields: { date: 'Invalid date' }});
    if (!batch_id) return res.status(400).json({ message: 'Validation failed', fields: { batch_id: 'batch_id required' }});
    if (!Array.isArray(records) || records.length === 0) return res.status(400).json({ message: 'Validation failed', fields: { records: 'records must be non-empty array' }});

    // validate student IDs belong to the batch
    const studentIds = records.map(r => Number(r.student_id)).filter(Boolean);
    const [students] = await pool.query('SELECT id FROM students WHERE id IN (?) AND batch_id = ?', [studentIds, batch_id]);
    const validStudentSet = new Set(students.map(s => s.id));
    const invalids = studentIds.filter(sid => !validStudentSet.has(sid));
    if (invalids.length) return res.status(400).json({ message: 'Validation failed', fields: { records: 'Some student(s) not in selected batch' }});

    // upsert
        const values = [];
        const placeholders = [];
        for (const r of records) {
          const sid = Number(r.student_id);
          const status = String(r.status) === 'Present' ? 'Present' : 'Absent';
          values.push(sid, date, status, (req.user && req.user.id) ? req.user.id : null);
          // ensure only the DATE portion is stored
          placeholders.push('(?, DATE(?), ?, ?)');
        }
    const sql = `
      INSERT INTO attendance (student_id, attendance_date, status, recorded_by)
      VALUES ${placeholders.join(',')}
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        recorded_by = VALUES(recorded_by),
        updated_at = CURRENT_TIMESTAMP
    `;
    await pool.query(sql, values);
    return res.json({ message: 'Saved', count: records.length });
  } catch (err) {
    console.error('POST /api/attendance', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/teachers/:id/attendance  (teacher marks attendance for their batch)
router.post('/teachers/:id/attendance', auth, async (req, res) => {
  try {
    const tid = Number(req.params.id);
    const user = req.user;
    const { date, batch_id, records } = req.body || {};

    if (!date || !isValidDateString(date)) return res.status(400).json({ message: 'Validation failed', fields: { date: 'Invalid date' }});
    if (!batch_id) return res.status(400).json({ message: 'Validation failed', fields: { batch_id: 'batch_id required' }});
    if (!Array.isArray(records) || records.length === 0) return res.status(400).json({ message: 'Validation failed', fields: { records: 'records must be non-empty array' }});

    // permission check
    if (!isAdmin(user) && !isSelf(user, tid)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (!isAdmin(user)) {
      const ok = await teacherHasBatch(tid, batch_id);
      if (!ok) return res.status(403).json({ message: 'Forbidden: not assigned to batch' });
    }

    // Validate students belong to batch
    const studentIds = records.map(r => Number(r.student_id)).filter(Boolean);
    if (!studentIds.length) return res.status(400).json({ message: 'Validation failed', fields: { records: 'student_id required' }});

    const [students] = await pool.query('SELECT id FROM students WHERE id IN (?) AND batch_id = ?', [studentIds, batch_id]);
    const validStudentSet = new Set(students.map(s => s.id));
    const invalids = studentIds.filter(sid => !validStudentSet.has(sid));
    if (invalids.length) return res.status(400).json({ message: 'Validation failed', fields: { records: 'Some student(s) not in selected batch' }});

    // upsert values
        // upsert values
    const values = [];
    const placeholders = [];
    for (const r of records) {
      const sid = Number(r.student_id);
      const status = String(r.status) === 'Present' ? 'Present' : 'Absent';
      values.push(sid, date, status, (user && user.id) ? user.id : null);
      // store attendance_date as DATE to avoid timezone shifts
      placeholders.push('(?, DATE(?), ?, ?)');
    }

    if (!values.length) return res.status(400).json({ message: 'Validation failed', fields: { records: 'No valid records' }});

    const sql = `
      INSERT INTO attendance (student_id, attendance_date, status, recorded_by)
      VALUES ${placeholders.join(',')}
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        recorded_by = VALUES(recorded_by),
        updated_at = CURRENT_TIMESTAMP
    `;
    await pool.query(sql, values);
    return res.json({ message: 'Saved', count: records.length });
  } catch (err) {
    console.error('POST /teachers/:id/attendance', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;