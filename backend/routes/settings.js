// routes/settings.js
const express = require('express');
const router = express.Router();
const pool = require('../db'); // mysql2 promise pool
const auth = require('../middleware/auth'); // JWT auth middleware
const bcrypt = require('bcrypt');

// helper to detect admin
function isAdmin(req) {
  return req.user && req.user.role === 'admin';
}

// require auth for all settings routes
router.use(auth);

/**
 * GET /api/settings/profile
 */
router.get('/profile', async (req, res) => {
  try {
    const { id, role } = req.user;
    if (role === 'admin') {
      const [rows] = await pool.query(
        'SELECT id, name, email, phone, created_at FROM admins WHERE id = ?',
        [id]
      );
      return res.json(rows[0] || null);
    } else if (role === 'teacher') {
      const [rows] = await pool.query(
        'SELECT id, name, email, phone, subject, specialization, created_at FROM teachers WHERE id = ?',
        [id]
      );
      return res.json(rows[0] || null);
    } else if (role === 'student') {
      const [rows] = await pool.query(
        'SELECT id, name, email, created_at FROM students WHERE id = ?',
        [id]
      );
      return res.json(rows[0] || null);
    } else {
      return res.status(403).json({ message: 'Forbidden' });
    }
  } catch (err) {
    console.error('GET /api/settings/profile', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

/**
 * PUT /api/settings/profile
 * Update fields for current user. Only updates phone if explicitly provided.
 */
router.put('/profile', async (req, res) => {
  try {
    const { id, role } = req.user;
    const { name, phone, password, subject, specialization } = req.body;

    const fields = [];
    const params = [];

    if (typeof name !== 'undefined' && name !== null) {
      fields.push('name = ?');
      params.push(name);
    }

    // Only update phone when request explicitly contains the property
    if (Object.prototype.hasOwnProperty.call(req.body, 'phone')) {
      fields.push('phone = ?');
      params.push(phone);
    }

    if (role === 'teacher') {
      if (typeof subject !== 'undefined') {
        fields.push('subject = ?');
        params.push(subject);
      }
      if (typeof specialization !== 'undefined') {
        fields.push('specialization = ?');
        params.push(specialization);
      }
    }

    if (typeof password !== 'undefined' && password) {
      const hash = await bcrypt.hash(password, 10);
      fields.push('password = ?');
      params.push(hash);
    }

    if (!fields.length) return res.status(400).json({ message: 'No fields to update' });

    params.push(id);
    const table = role === 'admin' ? 'admins' : role === 'teacher' ? 'teachers' : 'students';
    const sql = `UPDATE ${table} SET ${fields.join(', ')} WHERE id = ?`;
    await pool.query(sql, params);

    return res.json({ message: 'Updated' });
  } catch (err) {
    console.error('PUT /api/settings/profile', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

/**
 * GET /api/settings/school
 */
router.get('/school', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM school_info WHERE id = 1');
    return res.json(rows[0] || null);
  } catch (err) {
    console.error('GET /api/settings/school', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

/**
 * PUT /api/settings/school
 * Admin only
 */
router.put('/school', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ message: 'Forbidden' });

    const {
      name = null,
      address = null,
      phone = null,
      email = null,
      website = null,
      academic_year = null,
      timezone = null,
      logo_url = null
    } = req.body;

    const sql = `
      INSERT INTO school_info (id, name, address, phone, email, website, academic_year, timezone, logo_url)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name=VALUES(name), address=VALUES(address), phone=VALUES(phone),
        email=VALUES(email), website=VALUES(website),
        academic_year=VALUES(academic_year), timezone=VALUES(timezone), logo_url=VALUES(logo_url)
    `;
    await pool.query(sql, [name, address, phone, email, website, academic_year, timezone, logo_url]);
    return res.json({ message: 'Saved' });
  } catch (err) {
    console.error('PUT /api/settings/school', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

/**
 * GET /api/settings/notifications
 * - Admin: return full list (as before)
 * - Teacher/Student: return notifications filtered by audience and include is_read per current user
 * Returns: { notifications: [...], unread_count: N }
 */
// GET /api/settings/notifications
router.get('/notifications', async (req, res) => {
  try {
    const { role, id: uid } = req.user || {};

    // ADMIN: return plain array (keeps admin frontend compatible)
    if (role === 'admin') {
      const [rows] = await pool.query(
        'SELECT n.*, a.name AS created_by_name FROM notifications n LEFT JOIN admins a ON a.id = n.created_by ORDER BY n.created_at DESC'
      );
      return res.json(rows || []);          // <-- plain array for admin
    }

    // TEACHER/STUDENT: return notifications + unread_count and include is_read per user
    if (role === 'teacher' || role === 'student') {
      const audiences = role === 'teacher' ? ['teachers', 'both'] : ['students', 'both'];
      const placeholders = audiences.map(() => '?').join(',');
      const sql = `
        SELECT
          n.*,
          COALESCE(nr.is_read, 0) AS is_read,
          nr.read_at
        FROM notifications n
        LEFT JOIN notification_receipts nr
          ON nr.notification_id = n.id
          AND nr.user_type = ?
          AND nr.user_id = ?
        WHERE LOWER(n.audience) IN (${placeholders})
        ORDER BY n.created_at DESC
      `;
      const user_type = role === 'teacher' ? 'teacher' : 'student';
      const params = [user_type, uid, ...audiences];
      const [rows] = await pool.query(sql, params);

      const unread_count = Array.isArray(rows) ? rows.reduce((sum, r) => sum + (r.is_read ? 0 : 1), 0) : 0;
      return res.json({ notifications: rows || [], unread_count });
    }

    return res.status(403).json({ message: 'Forbidden' });
  } catch (err) {
    console.error('GET /api/settings/notifications', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

/**
 * POST /api/settings/notifications
 * Admin only — create notification.
 */
router.post('/notifications', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ message: 'Forbidden' });
    const adminId = req.user.id;
    let { type = 'notice', title, message, audience = 'both', send_at = null } = req.body;

    if (!title || !message) return res.status(400).json({ message: 'title and message required' });

    // normalize audience to expected DB values
    const a = String(audience || '').toLowerCase();
    if (a.includes('teacher')) audience = 'teachers';
    else if (a.includes('student')) audience = 'students';
    else audience = 'both';

    const [result] = await pool.query(
      'INSERT INTO notifications (created_by, type, title, message, audience, send_at) VALUES (?, ?, ?, ?, ?, ?)',
      [adminId, type, title, message, audience, send_at]
    );
    return res.status(201).json({ message: 'Created', id: result.insertId });
  } catch (err) {
    console.error('POST /api/settings/notifications', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/settings/notifications/:id
// Admin only — remove notification and its receipts
router.delete('/notifications/:id', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ message: 'Forbidden' });

    const nid = Number(req.params.id);
    if (!nid) return res.status(400).json({ message: 'Invalid id' });

    // delete receipts first (if any) then the notification
    await pool.query('DELETE FROM notification_receipts WHERE notification_id = ?', [nid]);
    const [result] = await pool.query('DELETE FROM notifications WHERE id = ?', [nid]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Not found' });
    }

    return res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('DELETE /api/settings/notifications/:id', err);
    return res.status(500).json({ message: 'Server error' });
  }
});


/**
 * POST /api/settings/notifications/:id/mark-read
 */
router.post('/notifications/:id/mark-read', async (req, res) => {
  try {
    const notifId = Number(req.params.id);
    if (!notifId) return res.status(400).json({ message: 'Invalid id' });
    const { role, id: uid } = req.user;
    if (!(role === 'teacher' || role === 'student')) return res.status(403).json({ message: 'Forbidden' });

    const user_type = role === 'teacher' ? 'teacher' : 'student';
    const now = new Date();

    await pool.query(
      `
      INSERT INTO notification_receipts (notification_id, user_type, user_id, is_read, read_at)
      VALUES (?, ?, ?, 1, ?)
      ON DUPLICATE KEY UPDATE is_read = 1, read_at = ?
      `,
      [notifId, user_type, uid, now, now]
    );

    return res.json({ message: 'Marked' });
  } catch (err) {
    console.error('POST /api/settings/notifications/:id/mark-read', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

/**
 * GET /api/settings/notifications/:id/receipts  (admin only)
 */
router.get('/notifications/:id/receipts', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ message: 'Forbidden' });
    const nid = Number(req.params.id);
    if (!nid) return res.status(400).json({ message: 'Invalid id' });
    const [rows] = await pool.query('SELECT * FROM notification_receipts WHERE notification_id = ?', [nid]);
    return res.json(rows);
  } catch (err) {
    console.error('GET /api/settings/notifications/:id/receipts', err);
    return res.status(500).json({ message: 'Server error' });
  }
});


/**
 * POST /api/settings/notifications/read-all
 * Mark all notifications as read for current user
 */
router.post('/notifications/read-all', async (req, res) => {
  try {
    const { role, id: uid } = req.user;
    if (!(role === 'teacher' || role === 'student')) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const user_type = role === 'teacher' ? 'teacher' : 'student';
    const now = new Date();

    await pool.query(
      `
      INSERT INTO notification_receipts (notification_id, user_type, user_id, is_read, read_at)
      SELECT n.id, ?, ?, 1, ?
      FROM notifications n
      WHERE LOWER(n.audience) IN (?, 'both')
      ON DUPLICATE KEY UPDATE is_read = 1, read_at = ?
      `,
      [
        user_type,
        uid,
        now,
        role === 'teacher' ? 'teachers' : 'students',
        now
      ]
    );

    return res.json({ message: 'All marked as read' });
  } catch (err) {
    console.error('POST /notifications/read-all', err);
    return res.status(500).json({ message: 'Server error' });
  }
});


module.exports = router;
