// backend/routes/students.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const auth = require("../middleware/auth");
const bcrypt = require("bcrypt");

function isAdmin(user) {
  return user && user.role === "admin";
}

function isStudent(user) {
  return user && user.role === "student";
}

// simple student validator
function validateStudentPayload(payload = {}, opts = {}) {
  const fields = {};
  const { roll_no, name, email, course, year } = payload;
  if (opts.requireRoll && (!roll_no || !/^[A-Za-z0-9-]{2,30}$/.test(roll_no))) {
    fields.roll_no = "Roll number required (alpha-numeric, 2-30 chars)";
  }
  if (opts.requireName && (!name || String(name).trim().length < 3)) {
    fields.name = "Full name required (min 3 chars)";
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fields.email = "Email is not valid";
  }
  if (opts.requireCourse && !course) {
    fields.course = "Course required";
  }
  if (year) {
    const y = Number(year);
    if (!Number.isInteger(y) || y < 2000 || y > 2100)
      fields.year = "Enter a valid year (e.g. 2025)";
  }
  return fields;
}

/*
  GET /api/students
  - Admin only (keeps existing behavior)
  - Supports optional query param `batch_id` to return only students in that batch.
    This is required by the frontend when it asks `/students?batch_id=...`.
*/
router.get("/", auth, async (req, res) => {
  try {
    if (!isAdmin(req.user))
      return res.status(403).json({ message: "Forbidden" });

    // optional filters
    const batchId = req.query.batch_id ? Number(req.query.batch_id) : null;
    // (you can add more filters later if needed: teacher_id, course, etc.)

    if (batchId) {
      // return students for given batch only
      const [rows] = await pool.query(
        `SELECT s.id, s.roll_no, s.name, s.email, s.course, s.year, s.batch_id, b.batch AS std, b.year AS batch_year
         FROM students s
         LEFT JOIN batches b ON s.batch_id = b.id
         WHERE s.batch_id = ?
         ORDER BY s.roll_no ASC`,
        [batchId],
      );
      return res.json(rows);
    }

    // no batch filter -> return all students (previous behavior)
    const [rows] = await pool.query(
      `SELECT s.id, s.roll_no, s.name, s.email, s.course, s.year, s.batch_id, b.batch AS std, b.year AS batch_year
       FROM students s
       LEFT JOIN batches b ON s.batch_id = b.id
       ORDER BY s.id DESC`,
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/students", err);
    res.status(500).json({ message: "Server error" });
  }
});

// create student
router.post("/", auth, async (req, res) => {
  try {
    if (!isAdmin(req.user))
      return res.status(403).json({ message: "Forbidden" });
    const { roll_no, name, email, course, year, password, batch_id, batch } =
      req.body || {};

    // validation
    const v = validateStudentPayload(
      { roll_no, name, email, course, year },
      { requireRoll: true, requireName: true, requireCourse: true },
    );
    if (Object.keys(v).length)
      return res.status(400).json({ message: "Validation failed", fields: v });

    // duplicate roll_no
    const [dup] = await pool.query(
      "SELECT id FROM students WHERE roll_no = ?",
      [roll_no],
    );
    if (dup.length)
      return res.status(400).json({
        message: "Validation failed",
        fields: { roll_no: "Roll number already exists" },
      });

    // batch handling: prefer batch_id; if textual batch provided, find or create matching batch (course+batch+year)
    let finalBatchId = null;
    if (batch_id) {
      // ensure exists
      const [brows] = await pool.query("SELECT id FROM batches WHERE id = ?", [
        batch_id,
      ]);
      if (brows.length) finalBatchId = batch_id;
      else
        return res.status(400).json({
          message: "Validation failed",
          fields: { batch: "Invalid batch selected" },
        });
    } else if (batch) {
      const targetYear = year || null;
      const [found] = await pool.query(
        "SELECT id FROM batches WHERE batch = ? AND course = ? AND year <=> ?",
        [batch, course || null, targetYear],
      );
      if (found.length) finalBatchId = found[0].id;
      else {
        const [ins] = await pool.query(
          "INSERT INTO batches (course, batch, year, created_at) VALUES (?, ?, ?, NOW())",
          [course || null, batch, targetYear],
        );
        finalBatchId = ins.insertId;
      }
    }

    // insert student
    let hashedPassword = null;

    if (password) {
      hashedPassword = await bcrypt.hash(password, 10);
    }

    const sql = `INSERT INTO students (roll_no, name, email, course, semester, password, batch_id, year, created_at)
                 VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NOW())`;
    const [result] = await pool.query(sql, [
      roll_no.trim(),
      name.trim(),
      email || null,
      course || null,
      hashedPassword,
      finalBatchId,
      year || null,
    ]);

    res.status(201).json({ id: result.insertId, message: "Student created" });
  } catch (err) {
    console.error("POST /api/students", err);
    res.status(500).json({ message: "Server error" });
  }
});

// get single student
router.get("/:id", auth, async (req, res) => {
  try {
    if (!isAdmin(req.user))
      return res.status(403).json({ message: "Forbidden" });
    const [rows] = await pool.query(
      `SELECT s.*, b.batch AS std, b.year AS batch_year FROM students s LEFT JOIN batches b ON s.batch_id = b.id WHERE s.id = ?`,
      [req.params.id],
    );
    if (!rows.length) return res.status(404).json({ message: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(`GET /api/students/${req.params.id}`, err);
    res.status(500).json({ message: "Server error" });
  }
});

// update student
router.put("/:id", auth, async (req, res) => {
  try {
    if (!isAdmin(req.user))
      return res.status(403).json({ message: "Forbidden" });
    const sid = req.params.id;
    const { roll_no, name, email, course, year, password, batch_id, batch } =
      req.body || {};

    if (
      !roll_no &&
      !name &&
      !email &&
      !course &&
      !year &&
      !password &&
      !batch_id &&
      !batch
    ) {
      return res.status(400).json({ message: "No fields to update" });
    }

    // validate partially
    const v = validateStudentPayload(
      { roll_no, name, email, course, year },
      { requireRoll: false, requireName: false, requireCourse: false },
    );
    if (Object.keys(v).length)
      return res.status(400).json({ message: "Validation failed", fields: v });

    // if roll_no given, ensure not duplicated
    if (roll_no) {
      const [dup] = await pool.query(
        "SELECT id FROM students WHERE roll_no = ? AND id <> ?",
        [roll_no, sid],
      );
      if (dup.length)
        return res.status(400).json({
          message: "Validation failed",
          fields: { roll_no: "Roll number already exists" },
        });
    }

    // batch handling like create
    let finalBatchId = undefined;
    if (batch_id) {
      const [brows] = await pool.query("SELECT id FROM batches WHERE id = ?", [
        batch_id,
      ]);
      if (!brows.length)
        return res.status(400).json({
          message: "Validation failed",
          fields: { batch: "Invalid batch selected" },
        });
      finalBatchId = batch_id;
    } else if (batch) {
      const targetYear = year || null;
      const [found] = await pool.query(
        "SELECT id FROM batches WHERE batch = ? AND course = ? AND year <=> ?",
        [batch, course || null, targetYear],
      );
      if (found.length) finalBatchId = found[0].id;
      else {
        const [ins] = await pool.query(
          "INSERT INTO batches (course, batch, year, created_at) VALUES (?, ?, ?, NOW())",
          [course || null, batch, targetYear],
        );
        finalBatchId = ins.insertId;
      }
    }

    // build update
    const set = [];
    const params = [];
    if (roll_no !== undefined) {
      set.push("roll_no = ?");
      params.push(roll_no || null);
    }
    if (name !== undefined) {
      set.push("name = ?");
      params.push(name || null);
    }
    if (email !== undefined) {
      set.push("email = ?");
      params.push(email || null);
    }
    if (course !== undefined) {
      set.push("course = ?");
      params.push(course || null);
    }
    if (year !== undefined) {
      set.push("year = ?");
      params.push(year || null);
    }
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      set.push("password = ?");
      params.push(hashedPassword);
    }
    if (finalBatchId !== undefined) {
      set.push("batch_id = ?");
      params.push(finalBatchId);
    }

    if (!set.length)
      return res.status(400).json({ message: "No valid fields to update" });

    params.push(sid);
    const sql = `UPDATE students SET ${set.join(", ")} WHERE id = ?`;
    await pool.query(sql, params);

    res.json({ message: "Updated" });
  } catch (err) {
    console.error(`PUT /api/students/${req.params.id}`, err);
    res.status(500).json({ message: "Server error" });
  }
});

// delete student (admin)
router.delete("/:id", auth, async (req, res) => {
  try {
    if (!isAdmin(req.user))
      return res.status(403).json({ message: "Forbidden" });
    await pool.query("DELETE FROM students WHERE id = ?", [req.params.id]);
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error(`DELETE /api/students/${req.params.id}`, err);
    res.status(500).json({ message: "Server error" });
  }
});

// ================= STUDENT SELF ROUTES =================

// GET /api/students/me/profile
router.get("/me/profile", auth, async (req, res) => {
  try {
    if (!isStudent(req.user)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const [rows] = await pool.query(
      `SELECT 
     s.id,
     s.roll_no,
     s.name,
     s.email,
     s.course,
     s.year,
     s.semester,
     b.batch AS batch,
     t.name AS teacher_name
   FROM students s
   LEFT JOIN batches b ON s.batch_id = b.id
   LEFT JOIN teacher_batches tb ON tb.batch_id = b.id
   LEFT JOIN teachers t ON t.id = tb.teacher_id
   WHERE s.id = ?`,
      [req.user.id],
    );

    res.json(rows[0] || null);
  } catch (err) {
    console.error("GET /students/me/profile", err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/students/me/change-password
router.post("/me/change-password", auth, async (req, res) => {
  try {
    if (!isStudent(req.user)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        message: "New password must be at least 6 characters long",
      });
    }

    // Get current password hash
    const [rows] = await pool.query(
      "SELECT password FROM students WHERE id = ?",
      [req.user.id]
    );

    if (!rows.length || !rows[0].password) {
      return res.status(400).json({ message: "Password not set" });
    }

    const isMatch = await bcrypt.compare(oldPassword, rows[0].password);
    if (!isMatch) {
      return res.status(400).json({ message: "Old password is incorrect" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    await pool.query(
      "UPDATE students SET password = ? WHERE id = ?",
      [hashed, req.user.id]
    );

    res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("POST /students/me/change-password", err);
    res.status(500).json({ message: "Server error" });
  }
});


// GET /api/students/me/attendance
router.get("/me/attendance", auth, async (req, res) => {
  try {
    if (!isStudent(req.user)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { from, to } = req.query;

    let sql = `
      SELECT attendance_date, status
      FROM attendance
      WHERE student_id = ?
    `;
    const params = [req.user.id];

    if (from) {
      sql += " AND attendance_date >= ?";
      params.push(from);
    }
    if (to) {
      sql += " AND attendance_date <= ?";
      params.push(to);
    }

    sql += " ORDER BY attendance_date DESC";

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("GET /students/me/attendance", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/students/me/marks
router.get("/me/marks", auth, async (req, res) => {
  try {
    if (!isStudent(req.user)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { semester } = req.query;

    let sql = `
      SELECT 
        subject,
        assessment,
        marks,
        max_marks,
        exam_date,
        semester
      FROM marks
      WHERE student_id = ?
    `;
    const params = [req.user.id];

    if (semester) {
      sql += " AND semester = ?";
      params.push(Number(semester));
    }

    sql += " ORDER BY exam_date DESC";

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("GET /students/me/marks", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET assignments for logged-in student
router.get("/student", auth, async (req, res) => {
  if (req.user.role !== "student")
    return res.status(403).json({ message: "Forbidden" });

  try {
    const [rows] = await pool.query(
      `
      SELECT 
        a.id,
        a.title,
        a.subject,
        a.due_date,
        s.id AS submission_id,
        s.submitted_at,
        s.marks
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
    console.error("student assignments", err);
    res.status(500).json({ message: "Server error" });
  }
});


module.exports = router;
