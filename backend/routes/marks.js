// backend/routes/marks.js
// Bulk upsert marks and read endpoints for admin + teacher-scoped

const express = require("express");
const router = express.Router();

// normalize incoming payload
function buildPayload(body) {
  const date = body.date || null;
  const batch_id =
    typeof body.batch_id !== "undefined" && body.batch_id !== ""
      ? Number(body.batch_id)
      : null;
  const assessment = body.assessment || null;
  const max_marks =
    typeof body.max_marks !== "undefined" && body.max_marks !== ""
      ? Number(body.max_marks)
      : null;
  const records = Array.isArray(body.records) ? body.records : [];
  return { date, batch_id, assessment, max_marks, records };
}

// ------------------------
// POST /api/marks
// Accepts payload { date, batch_id, assessment, max_marks, records: [...] }
// NOTE: IMPORTANT — this router is expected to be mounted at '/api/marks'
// so defining the route at '/' makes the final path '/api/marks' (matches frontend)
// ------------------------
router.post("/", async (req, res) => {
  const db = req.app.locals.db;
  if (!db) return res.status(500).json({ message: "DB not configured" });

  const p = buildPayload(req.body);

  // Basic validation: require batch_id and assessment for meaningful upsert
  if (!p.batch_id || !p.assessment) {
    return res
      .status(400)
      .json({ message: "batch_id and assessment are required" });
  }
  if (!p.records.length) {
    return res.status(400).json({ message: "No records provided" });
  }

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const upsertSql = `
      INSERT INTO marks
        (student_id, batch_id, assessment, exam_date, subject, marks, semester, recorded_by, max_marks, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        subject = VALUES(subject),
        marks = VALUES(marks),
        semester = VALUES(semester),
        recorded_by = VALUES(recorded_by),
        max_marks = VALUES(max_marks),
        updated_at = NOW()
    `;

    for (const r of p.records) {
      const student_id = Number(r.student_id || 0);
      if (!student_id) {
        await conn.rollback();
        return res
          .status(400)
          .json({ message: "Each record must include student_id" });
      }
      const subject = typeof r.subject !== "undefined" ? r.subject : null;
      const marks =
        typeof r.marks === "undefined" || r.marks === null
          ? null
          : Number(r.marks);
      const semester =
        typeof r.semester !== "undefined" && r.semester !== null
          ? Number(r.semester)
          : null;
      const recorded_by =
        typeof r.recorded_by !== "undefined" && r.recorded_by !== null
          ? Number(r.recorded_by)
          : null;

      await conn.query(upsertSql, [
        student_id,
        p.batch_id,
        p.assessment,
        p.date,
        subject,
        marks,
        semester,
        recorded_by,
        p.max_marks,
      ]);
    }

    await conn.commit();
    return res.json({ message: "Marks saved", count: p.records.length });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error("marks POST error", err);
    return res
      .status(500)
      .json({ message: "Database error", error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// ------------------------
// GET /api/marks
// Query params: batch_id, assessment, date, student_id
// Returns enriched rows joined with students and teachers so frontend can display roll/name/email/batch/teacher
// ------------------------
router.get("/", async (req, res) => {
  const db = req.app.locals.db;
  if (!db) return res.status(500).json({ message: "DB not configured" });

  const { batch_id, assessment, date, student_id } = req.query;
  const filters = [];
  const params = [];
  if (batch_id) {
    filters.push("m.batch_id = ?");
    params.push(Number(batch_id));
  }
  if (student_id) {
    filters.push("m.student_id = ?");
    params.push(Number(student_id));
  }
  if (assessment) {
    filters.push("m.assessment = ?");
    params.push(assessment);
  }

  // Improved date handling:
  // Accept either 'YYYY-MM-DD' (ISO) or 'DD-MM-YYYY' (locale format from UI).
  // Use DATE_FORMAT to compare string forms and also exclude NULL exam_date when date filter is provided.
  if (date) {
    const ddmmyyyy = /^\d{2}-\d{2}-\d{4}$/;
    const yyyymmdd = /^\d{4}-\d{2}-\d{2}$/;
    if (ddmmyyyy.test(date)) {
      // compare using day-month-year format
      filters.push(
        'm.exam_date IS NOT NULL AND DATE_FORMAT(m.exam_date, "%d-%m-%Y") = ?'
      );
      params.push(date);
    } else if (yyyymmdd.test(date)) {
      // compare using year-month-day format
      filters.push(
        'm.exam_date IS NOT NULL AND DATE_FORMAT(m.exam_date, "%Y-%m-%d") = ?'
      );
      params.push(date);
    } else {
      // fallback: try matching DATE(...) (covers some other DB-compatible formats)
      filters.push("m.exam_date IS NOT NULL AND DATE(m.exam_date) = DATE(?)");
      params.push(date);
    }
  }

  const where = filters.length ? "WHERE " + filters.join(" AND ") : "";
  // join to students and teachers to give frontend required display fields
  const sql = `
    SELECT
      m.*,
      s.roll_no AS student_roll_no,
      s.name AS student_name,
      s.email AS student_email,
      s.batch_id AS student_batch_id,
      b.batch AS student_std,
      b.year AS student_batch_year,
      t.name AS teacher_name,
      t.email AS teacher_email
    FROM marks m
    LEFT JOIN students s ON s.id = m.student_id
    LEFT JOIN batches b ON s.batch_id = b.id
    LEFT JOIN teachers t ON t.id = m.recorded_by
    ${where}
    ORDER BY
      CASE WHEN s.roll_no IS NOT NULL AND s.roll_no <> '' THEN CAST(s.roll_no AS UNSIGNED) ELSE m.student_id END,
      m.exam_date DESC
  `;

  try {
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("marks GET error", err);
    res.status(500).json({ message: "DB error", error: err.message });
  }
});

// ------------------------
// Teacher-scoped endpoints
// Keep a teacher-scoped POST & GET here too. The frontend sometimes hits /api/teachers/:tid/marks
// If your server mounts this file at /api (instead of /api/marks), these routes will respond directly.
// If your server mounts at /api/marks, ensure your teachers router either proxies or the frontend uses /api/marks for teacher fallback.
// ------------------------

// POST /api/marks/teachers/:tid/marks  (this helps when marks router is mounted at /api/marks)
router.post("/teachers/:tid/marks", async (req, res, next) => {
  // ensure records have recorded_by if not present
  if (Array.isArray(req.body.records)) {
    req.body.records = req.body.records.map((r) => {
      if (typeof r.recorded_by === "undefined" || r.recorded_by === null) {
        r.recorded_by = Number(req.params.tid);
      }
      return r;
    });
  }
  // forward to the root POST handler by rewriting url & invoking this router
  // set url to '/' so the POST '/' handler above will run
  req.url = "/";
  return router.handle(req, res, next);
});

// GET /api/marks/teachers/:tid/marks  (teacher-scoped read)
router.get("/teachers/:tid/marks", async (req, res) => {
  const db = req.app.locals.db;
  if (!db) return res.status(500).json({ message: "DB not configured" });

  const { batch_id, assessment, date, student_id } = req.query;
  const filters = [];
  const params = [];

  // restrict to this teacher explicitly
  const tid = Number(req.params.tid);
  if (!Number.isFinite(tid) || tid <= 0) {
    return res.status(400).json({ message: "Invalid teacher id" });
  }
  filters.push("m.recorded_by = ?");
  params.push(tid);

  if (batch_id) {
    filters.push("m.batch_id = ?");
    params.push(Number(batch_id));
  }
  if (student_id) {
    filters.push("m.student_id = ?");
    params.push(Number(student_id));
  }
  if (assessment) {
    filters.push("m.assessment = ?");
    params.push(assessment);
  }

  // Improved date handling (same robust behavior as generic GET)
  if (date) {
    const ddmmyyyy = /^\d{2}-\d{2}-\d{4}$/;
    const yyyymmdd = /^\d{4}-\d{2}-\d{2}$/;
    if (ddmmyyyy.test(date)) {
      filters.push(
        'm.exam_date IS NOT NULL AND DATE_FORMAT(m.exam_date, "%d-%m-%Y") = ?'
      );
      params.push(date);
    } else if (yyyymmdd.test(date)) {
      filters.push(
        'm.exam_date IS NOT NULL AND DATE_FORMAT(m.exam_date, "%Y-%m-%d") = ?'
      );
      params.push(date);
    } else {
      filters.push("m.exam_date IS NOT NULL AND DATE(m.exam_date) = DATE(?)");
      params.push(date);
    }
  }

  const where = filters.length ? "WHERE " + filters.join(" AND ") : "";

  const sql = `
    SELECT
      m.*,
      s.roll_no AS student_roll_no,
      s.name AS student_name,
      s.email AS student_email,
      s.batch_id AS student_batch_id,
      b.batch AS student_std,
      b.year AS student_batch_year,
      t.name AS teacher_name,
      t.email AS teacher_email
    FROM marks m
    LEFT JOIN students s ON s.id = m.student_id
    LEFT JOIN batches b ON s.batch_id = b.id
    LEFT JOIN teachers t ON t.id = m.recorded_by
    ${where}
    ORDER BY
      CASE WHEN s.roll_no IS NOT NULL AND s.roll_no <> '' THEN CAST(s.roll_no AS UNSIGNED) ELSE m.student_id END,
      m.exam_date DESC
  `;

  try {
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("teacher marks GET error", err);
    res.status(500).json({ message: "DB error", error: err.message });
  }
});

module.exports = router;
