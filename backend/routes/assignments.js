const express = require('express');
const router = express.Router();
const pool = require('../db');
const auth = require('../middleware/auth');
const multer = require("multer");
const path = require("path");

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/assignments");
  },
  filename: (req, file, cb) => {
    const unique =
      Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only PDF, DOC, DOCX allowed"));
    }
    cb(null, true);
  },
});

// teacher routes for assignments
/*
  GET /api/assignments/teacher/:teacherId
  → list assignments created by this teacher
*/
router.get('/teacher/:teacherId', auth, async (req, res) => {
  const teacherId = Number(req.params.teacherId);

  // security: teacher can only see own assignments
  if (req.user.role !== 'teacher' || req.user.id !== teacherId) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  try {
    const [rows] = await pool.query(`
      SELECT a.*, b.course, b.batch, b.year
      FROM assignments a
      JOIN batches b ON a.batch_id = b.id
      WHERE a.teacher_id = ?
      ORDER BY a.created_at DESC
    `, [teacherId]);

    res.json(rows);
  } catch (err) {
    console.error('GET assignments', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/*
  POST /api/assignments
  → create assignment (teacher)
*/
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const { batch_id, subject, title, description, due_date } = req.body;

  if (!batch_id || !subject || !title) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    const [result] = await pool.query(`
      INSERT INTO assignments
        (teacher_id, batch_id, subject, title, description, due_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      req.user.id,
      batch_id,
      subject,
      title,
      description || null,
      due_date || null
    ]);

    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error('POST assignment', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET submissions for a specific assignment (teacher)
router.get("/:id/submissions", auth, async (req, res) => {
  if (req.user.role !== "teacher") {
    return res.status(403).json({ message: "Forbidden" });
  }

  const assignmentId = Number(req.params.id);

  try {
    // 1️⃣ Verify assignment belongs to this teacher
    const [assignRows] = await pool.query(
      "SELECT batch_id FROM assignments WHERE id=? AND teacher_id=?",
      [assignmentId, req.user.id]
    );

    if (!assignRows.length) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    const batchId = assignRows[0].batch_id;

    // 2️⃣ Get students + submissions
    const [rows] = await pool.query(
      `
      SELECT
        st.id AS student_id,
        st.roll_no,
        st.name,
        sub.id AS submission_id,
        sub.submitted_at,
        sub.file_path,
        sub.submission_text,
        sub.marks,
        sub.feedback
      FROM students st
      LEFT JOIN assignment_submissions sub
        ON sub.student_id = st.id
        AND sub.assignment_id = ?
      WHERE st.batch_id = ?
      ORDER BY st.roll_no
      `,
      [assignmentId, batchId]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET submissions", err);
    res.status(500).json({ message: "Server error" });
  }
});


// student routes for assignments
// STUDENT: view assignments for logged-in student
router.get("/student", auth, async (req, res) => {
  if (req.user.role !== "student") {
    return res.status(403).json({ message: "Forbidden" });
  }

  try {
    const [rows] = await pool.query(
      `
      SELECT 
        a.id,
        a.title,
        a.subject,
        a.description,
        a.due_date,
        s.id AS submission_id,
        s.submitted_at,
        s.marks,
        s.feedback,
        s.file_path,
        s.submission_text
      FROM assignments a
      JOIN students st ON st.batch_id = a.batch_id
      LEFT JOIN assignment_submissions s
        ON s.assignment_id = a.id
        AND s.student_id = st.id
      WHERE st.id = ?
      ORDER BY a.created_at DESC
      `,
      [req.user.id]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /assignments/student", err);
    res.status(500).json({ message: "Server error" });
  }
});

// STUDENT: submit assignment
router.post(
  "/:id/submit",
  auth,
  upload.single("file"),
  async (req, res) => {
    if (req.user.role !== "student") {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (!req.file && !req.body.submission_text) {
      return res.status(400).json({
        message: "File or text submission required",
      });
    }

    try {
      await pool.query(
        `
        INSERT INTO assignment_submissions
          (assignment_id, student_id, submission_text, file_path)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          submission_text = VALUES(submission_text),
          file_path = VALUES(file_path),
          submitted_at = NOW()
        `,
        [
          req.params.id,
          req.user.id,
          req.body.submission_text || null,
          req.file ? req.file.filename : null,
        ]
      );

      res.json({ message: "Assignment submitted" });
    } catch (err) {
      console.error("submit assignment", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);



// Generic routes
// UPDATE assignment
router.put('/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  const { batch_id, subject, title, description, due_date } = req.body;

  try {
    const [rows] = await pool.query(
      'SELECT teacher_id FROM assignments WHERE id = ?',
      [id]
    );

    if (!rows.length || rows[0].teacher_id !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    await pool.query(`
      UPDATE assignments
      SET batch_id=?, subject=?, title=?, description=?, due_date=?
      WHERE id=?
    `, [
      batch_id,
      subject,
      title,
      description || null,
      due_date || null,
      id
    ]);

    res.json({ message: 'Updated' });
  } catch (err) {
    console.error('update assignment', err);
    res.status(500).json({ message: 'Server error' });
  }
});


/*
  DELETE /api/assignments/:id
  → teacher deletes own assignment
*/
router.delete('/:id', auth, async (req, res) => {
  const assignmentId = Number(req.params.id);

  try {
    const [rows] = await pool.query(
      'SELECT teacher_id FROM assignments WHERE id = ?',
      [assignmentId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Not found' });
    }

    if (rows[0].teacher_id !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    await pool.query('DELETE FROM assignments WHERE id = ?', [assignmentId]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('DELETE assignment', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT review submission (marks & feedback)
router.put("/submissions/:id/review", auth, async (req, res) => {
  if (req.user.role !== "teacher") {
    return res.status(403).json({ message: "Forbidden" });
  }

  const submissionId = Number(req.params.id);
  const { marks, feedback } = req.body;

  // validate marks (0–10)
  if (marks !== null && (marks < 0 || marks > 10)) {
    return res.status(400).json({
      message: "Marks must be between 0 and 10",
    });
  }

  try {
    // ensure submission belongs to teacher
    const [rows] = await pool.query(
      `
      SELECT a.teacher_id
      FROM assignment_submissions s
      JOIN assignments a ON s.assignment_id = a.id
      WHERE s.id = ?
      `,
      [submissionId]
    );

    if (!rows.length || rows[0].teacher_id !== req.user.id) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await pool.query(
      `
      UPDATE assignment_submissions
      SET marks=?, feedback=?, reviewed_at=NOW()
      WHERE id=?
      `,
      [marks, feedback || null, submissionId]
    );

    res.json({ message: "Review saved" });
  } catch (err) {
    console.error("review submission", err);
    res.status(500).json({ message: "Server error" });
  }
});


module.exports = router;