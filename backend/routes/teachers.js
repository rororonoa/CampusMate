// backend/routes/teachers.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const auth = require("../middleware/auth");
// at top of routes/teachers.js (after other requires)
const marksRouter = require("./marks");
// XP reward values
const XP_ATTENDANCE = 10; // per attendance submission
const XP_MARKS = 15; // per marks submission
const MAX_LEVEL = 10;

// POST /api/teachers/:tid/marks  (FINAL WORKING VERSION)
router.post("/:tid/marks", auth, async (req, res, next) => {
  const tid = Number(req.params.tid);

  // force recorded_by
  if (Array.isArray(req.body.records)) {
    req.body.records = req.body.records.map((r) => ({
      ...r,
      recorded_by: tid,
    }));
  }

  // forward request to marks router
  req.url = "/";

  const originalJson = res.json.bind(res);

  res.json = async (body) => {
    try {
      console.log("[XP wrapper] response body:", JSON.stringify(body));
    } catch (e) {
      /* ignore stringify errors */
    }

    // award XP if response indicates success (be permissive)
    const message = body && (body.message || body.msg || body.status);
    const okFlag = body && (body.ok === true || body.success === true);
    if (
      (message && /mark|save|saved|success/i.test(String(message))) ||
      okFlag
    ) {
      try {
        console.log("[XP] awarding MARKS XP ->", tid, XP_MARKS);
        await addTeacherXP(tid, XP_MARKS);
      } catch (err) {
        console.warn("[XP] failed to award marks XP:", err);
      }
    }
    return originalJson(body);
  };

  return marksRouter.handle(req, res, next);
});

// GET /api/teachers/:tid/marks
router.get("/:tid/marks", (req, res, next) => {
  req.url = `/teachers/${req.params.tid}/marks${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""
    }`;
  return marksRouter.handle(req, res, next);
});

function isAdmin(user) {
  return user && user.role === "admin";
}
function isSelf(user, id) {
  return user && Number(user.id) === Number(id);
}

// helper: ensure numeric-safe roll ordering (used in SELECTs)
const ROLL_ORDER_SQL = `(
  CASE WHEN s.roll_no REGEXP '^[0-9]+' THEN CAST(s.roll_no AS UNSIGNED) ELSE 999999 END
), s.roll_no`;

// ================= XP SYSTEM HELPERS =================

async function addTeacherXP(teacherId, amount) {
  try {
    console.log("[XP] addTeacherXP called ->", { teacherId, amount });
    const sql = `
      UPDATE teachers
      SET xp = xp + ?,
          updated_at = NOW()
      WHERE id = ?
    `;
    const [r] = await pool.query(sql, [amount, teacherId]);
    console.log(
      "[XP] addTeacherXP update result:",
      r && r.affectedRows ? "ok" : "norows"
    );
    // after updating xp, run level-up check
    await checkTeacherLevelUp(teacherId);
    console.log("[XP] addTeacherXP finished for", teacherId);
  } catch (err) {
    console.error("[XP] addTeacherXP ERROR", err);
    throw err; // rethrow so callers see an error if needed
  }
}

async function checkTeacherLevelUp(teacherId) {
  const [rows] = await pool.query(
    `SELECT xp, level, next_xp_target FROM teachers WHERE id = ?`,
    [teacherId]
  );

  if (!rows.length) return;

  let { xp, level, next_xp_target } = rows[0];

  // already max level → nothing to do
  if (level >= MAX_LEVEL) return;

  // level-up loop (supports gaining multiple levels if XP jumps high)
  while (xp >= next_xp_target && level < MAX_LEVEL) {
    xp -= next_xp_target;
    level++;

    // new target = +150 per level, but level 10 is final
    next_xp_target = level < MAX_LEVEL ? next_xp_target + 150 : next_xp_target;

    await pool.query(
      `
      UPDATE teachers
      SET xp = ?, level = ?, next_xp_target = ?
      WHERE id = ?
    `,
      [xp, level, next_xp_target, teacherId]
    );
  }
}

/*
  GET  /api/teachers           -> list teachers (admin)
  POST /api/teachers           -> create teacher (admin)
  GET  /api/teachers/:id       -> get teacher
  PUT  /api/teachers/:id       -> update teacher (admin)
  DELETE /api/teachers/:id     -> delete teacher (admin)
  POST /api/teachers/:id/batches    -> assign batches (admin)
  DELETE /api/teachers/:id/batches/:batchId -> unassign (admin)
  GET  /api/teachers/:id/batches -> list assigned batch ids
  GET  /api/teachers/:id/summary -> teacher summary used by frontend dashboard
  GET  /api/teachers/:id/students -> students assigned to teacher (by batch)
  GET  /api/teachers/:id/attendance?date=YYYY-MM-DD&batch_id= -> attendance (teacher)
  POST /api/teachers/:id/attendance -> mark attendance (teacher)
*/

// list teachers (admin)
router.get("/", auth, async (req, res) => {
  try {
    if (!isAdmin(req.user))
      return res.status(403).json({ message: "Forbidden" });
    const [rows] = await pool.query(
      "SELECT id, name, email, subject, specialization FROM teachers ORDER BY name"
    );
    return res.json(rows);
  } catch (err) {
    console.error("GET /teachers", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// create teacher (admin)
router.post("/", auth, async (req, res) => {
  try {
    if (!isAdmin(req.user))
      return res.status(403).json({ message: "Forbidden" });
    const { name, email, subject, specialization, password } = req.body || {};
    if (!name || !email)
      return res.status(400).json({
        message: "Validation failed",
        fields: { name: "Required", email: "Required" },
      });
    // You may want to hash the password in real app; here we just insert default if omitted
    const pwd = password || "teacher123";
    const [result] = await pool.query(
      "INSERT INTO teachers (name, email, subject, specialization, password) VALUES (?, ?, ?, ?, ?)",
      [name, email, subject || null, specialization || null, pwd]
    );
    const [teacher] = await pool.query(
      "SELECT id, name, email, subject, specialization FROM teachers WHERE id = ?",
      [result.insertId]
    );
    return res.status(201).json(teacher[0]);
  } catch (err) {
    console.error("POST /teachers", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// get teacher
// GET /api/teachers/:id  (Fetch single teacher for Edit)
router.get("/:id", auth, async (req, res) => {
  try {
    if (!isAdmin(req.user))
      return res.status(403).json({ message: "Forbidden" });

    const id = Number(req.params.id);

    const [rows] = await pool.query(
      "SELECT id, name, email, subject, specialization FROM teachers WHERE id = ?",
      [id]
    );

    if (!rows.length)
      return res.status(404).json({ message: "Teacher not found" });

    return res.json(rows[0]);
  } catch (err) {
    console.error("GET /teachers/:id", err);
    return res.status(500).json({ message: "Server error" });
  }
});


// update teacher (admin)
router.put("/:id", auth, async (req, res) => {
  try {
    if (!isAdmin(req.user))
      return res.status(403).json({ message: "Forbidden" });
    const id = Number(req.params.id);
    const { name, email, subject, specialization, password } = req.body || {};
    const [rows] = await pool.query("SELECT id FROM teachers WHERE id = ?", [
      id,
    ]);
    if (!rows.length) return res.status(404).json({ message: "Not found" });
    await pool.query(
      "UPDATE teachers SET name = ?, email = ?, subject = ?, specialization = ? WHERE id = ?",
      [name, email, subject || null, specialization || null, id]
    );
    if (password)
      await pool.query("UPDATE teachers SET password = ? WHERE id = ?", [
        password,
        id,
      ]);
    const [updated] = await pool.query(
      "SELECT id, name, email, subject, specialization FROM teachers WHERE id = ?",
      [id]
    );
    return res.json(updated[0]);
  } catch (err) {
    console.error("PUT /teachers/:id", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// delete teacher (admin)
router.delete("/:id", auth, async (req, res) => {
  try {
    if (!isAdmin(req.user))
      return res.status(403).json({ message: "Forbidden" });
    const id = Number(req.params.id);
    await pool.query("DELETE FROM teacher_batches WHERE teacher_id = ?", [id]);
    await pool.query("DELETE FROM teachers WHERE id = ?", [id]);
    return res.json({ message: "Deleted" });
  } catch (err) {
    console.error("DELETE /teachers/:id", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/* Assign batches (bulk) */
router.post("/:id/batches", auth, async (req, res) => {
  try {
    if (!isAdmin(req.user))
      return res.status(403).json({ message: "Forbidden" });
    const teacherId = Number(req.params.id);
    const batchIds = Array.isArray(req.body.batchIds)
      ? req.body.batchIds.map(Number).filter(Boolean)
      : [];
    if (!batchIds.length)
      return res.status(400).json({ message: "batchIds required" });
    // insert ignore
    const placeholders = batchIds.map(() => "(?, ?)").join(",");
    const values = [];
    for (const b of batchIds) {
      values.push(teacherId, b);
    }
    const sql = `INSERT IGNORE INTO teacher_batches (teacher_id, batch_id) VALUES ${placeholders}`;
    await pool.query(sql, values);
    return res.json({ message: "Assigned" });
  } catch (err) {
    console.error("POST /teachers/:id/batches", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// list assigned batch ids
router.get("/:id/batches", auth, async (req, res) => {
  try {
    const teacherId = Number(req.params.id);
    const [rows] = await pool.query(
      "SELECT batch_id FROM teacher_batches WHERE teacher_id = ?",
      [teacherId]
    );
    return res.json({ batchIds: rows.map((r) => r.batch_id) });
  } catch (err) {
    console.error("GET /teachers/:id/batches", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// unassign
router.delete("/:id/batches/:batchId", auth, async (req, res) => {
  try {
    if (!isAdmin(req.user))
      return res.status(403).json({ message: "Forbidden" });
    const teacherId = Number(req.params.id);
    const batchId = Number(req.params.batchId);
    await pool.query(
      "DELETE FROM teacher_batches WHERE teacher_id = ? AND batch_id = ?",
      [teacherId, batchId]
    );
    return res.json({ message: "Unassigned" });
  } catch (err) {
    console.error("DELETE /teachers/:id/batches/:batchId", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/* Teacher summary for frontend dashboard:
   GET /api/teachers/:id/summary
   returns { teacher: {...}, batchIds: [...], course, batch, year } etc.
*/
router.get("/:id/summary", auth, async (req, res) => {
  try {
    const teacherId = Number(req.params.id);
    const [trows] = await pool.query(
      "SELECT id, name, email, subject, specialization FROM teachers WHERE id = ?",
      [teacherId]
    );
    if (!trows.length)
      return res.status(404).json({ message: "Teacher not found" });
    const teacher = trows[0];
    const [brows] = await pool.query(
      `SELECT b.id, b.course, b.batch, b.year FROM teacher_batches tb JOIN batches b ON tb.batch_id = b.id WHERE tb.teacher_id = ?`,
      [teacherId]
    );
    // gather display info - you may want to join multiple batches into a string
    const batchIds = brows.map((b) => b.id);
    const batchDisplay = brows.length
      ? `${brows[0].course || ""} ${brows[0].batch || ""}`
      : null;
    return res.json({
      teacher,
      batchIds,
      assignedBatches: brows,
      batchDisplay,
    });
  } catch (err) {
    console.error("GET /teachers/:id/summary", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/teachers/:id/dashboard
// returns combined data: studentsCount, todayAttendanceCount, attendance7 (last 7 days for first assigned batch),
// notifications (up to 10), unread_count, assignedBatches
// ======= REPLACE or ADD this entire block for GET /api/teachers/:id/dashboard =======
router.get("/:id/dashboard", auth, async (req, res) => {
  try {
    const teacherId = Number(req.params.id);
    if (!teacherId)
      return res.status(400).json({ message: "Invalid teacher id" });

    // 1) assigned batches
    const [brows] = await pool.query(
      `SELECT b.id, b.course, b.batch, b.year
       FROM teacher_batches tb
       JOIN batches b ON tb.batch_id = b.id
       WHERE tb.teacher_id = ?`,
      [teacherId]
    );
    const assignedBatches = brows || [];
    const firstBatchId = assignedBatches.length ? assignedBatches[0].id : null;

    // 2) students count (all batches assigned to teacher)
    const [scRows] = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM students s
       JOIN teacher_batches tb ON s.batch_id = tb.batch_id
       WHERE tb.teacher_id = ?`,
      [teacherId]
    );
    const studentsCount =
      scRows && scRows[0] && scRows[0].cnt ? Number(scRows[0].cnt) : 0;

    // 3) last 7 dates (server-local dates, not UTC)
    // --- build last 7 UTC calendar dates (YYYY-MM-DD) to match DATE(...) grouping in DB
    const last7Dates = [];
    const now = new Date(); // local date
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);

      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");

      last7Dates.push(`${yyyy}-${mm}-${dd}`);
    }

    // default attendance7 (zeros)
    let attendance7 = last7Dates.map((d) => ({
      date: d,
      total: 0,
      presents: 0,
      pct: 0,
    }));

    if (firstBatchId) {
      try {
        // Query grouped by date string (YYYY-MM-DD) — return string (no JS Date objects)
        const datePlaceholders = last7Dates.map(() => "?").join(",");
        const sql = `
          SELECT DATE_FORMAT(a.attendance_date, '%Y-%m-%d') AS dt,
            COUNT(*) AS total,
            SUM(CASE WHEN a.status = 'Present' THEN 1 ELSE 0 END) AS presents
          FROM attendance a
          JOIN students s ON s.id = a.student_id
          WHERE DATE_FORMAT(a.attendance_date, '%Y-%m-%d') IN (${datePlaceholders})
            AND s.batch_id = ?
          GROUP BY DATE_FORMAT(a.attendance_date, '%Y-%m-%d')
          `;
        const params = [...last7Dates, firstBatchId];
        const [aRows] = await pool.query(sql, params);

        // TEMP DEBUG: log what DB returned so you can verify day mapping (remove when satisfied)
        console.log(
          "dashboard: teacherId=%d last7Dates=%o aRows=%o",
          teacherId,
          last7Dates,
          aRows
        );

        const byDate = {};
        for (const r of aRows) {
          const dt =
            r.dt && typeof r.dt === "string" ? r.dt.slice(0, 10) : String(r.dt);
          const total = Number(r.total || 0);
          const presents = Number(r.presents || 0);
          const pct = total > 0 ? Math.round((presents / total) * 100) : 0;
          byDate[dt] = { date: dt, total, presents, pct };
        }

        attendance7 = last7Dates.map(
          (d) => byDate[d] || { date: d, total: 0, presents: 0, pct: 0 }
        );
      } catch (attErr) {
        console.error("dashboard: attendance aggregation failed", attErr);
        // keep attendance7 as zeros
      }
    }

    // 4) today's attendance count for first batch (defensive)
    // === compute today's attendance count AND today's total students for firstBatchId ===
    let todayAttendanceCount = 0;
    let todayTotal = 0; // NEW
    if (firstBatchId) {
      try {
        const td = new Date();
        const todayStr = `${td.getFullYear()}-${String(
          td.getMonth() + 1
        ).padStart(2, "0")}-${String(td.getDate()).padStart(2, "0")}`;
        // presents
        const [tRows] = await pool.query(
          `SELECT SUM(CASE WHEN a.status = 'Present' THEN 1 ELSE 0 END) AS presents
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       WHERE a.attendance_date = ? AND s.batch_id = ?`,
          [todayStr, firstBatchId]
        );
        todayAttendanceCount =
          tRows && tRows[0] && tRows[0].presents
            ? Number(tRows[0].presents)
            : 0;

        // total students in that batch (so we can show "P out of N")
        const [totRows] = await pool.query(
          `SELECT COUNT(*) AS cnt FROM students WHERE batch_id = ?`,
          [firstBatchId]
        );
        todayTotal =
          totRows && totRows[0] && totRows[0].cnt ? Number(totRows[0].cnt) : 0;
      } catch (todayErr) {
        console.error(
          "dashboard: today attendance count/total failed",
          todayErr
        );
        todayAttendanceCount = 0;
        todayTotal = 0;
      }
    }

    // 5) notifications — use notifications + notification_receipts schema
    let notifications = [];
    let unread_count = 0;
    try {
      // left join receipts for this teacher (user_type = 'teacher', user_id = teacherId)
      const [nRows] = await pool.query(
        `SELECT 
           n.id,
           n.title,
           n.message,
           n.type,
           n.send_at,
           n.created_at,
           COALESCE(nr.is_read, 0) AS is_read,
           nr.read_at
         FROM notifications n
         LEFT JOIN notification_receipts nr
           ON nr.notification_id = n.id
           AND nr.user_type = 'teacher'
           AND nr.user_id = ?
         WHERE (n.audience IN ('teachers', 'both'))
           AND (n.send_at IS NULL OR n.send_at <= NOW())
         ORDER BY n.created_at DESC
         LIMIT 10`,
        [teacherId]
      );

      notifications = (nRows || []).map((r) => ({
        id: r.id,
        title: r.title,
        message: r.message,
        type: r.type,
        send_at: r.send_at,
        created_at: r.created_at,
        is_read: Number(r.is_read) === 1,
        read_at: r.read_at || null,
      }));

      unread_count = notifications.filter((n) => !n.is_read).length;
    } catch (notifErr) {
      console.error("dashboard: notifications query failed", notifErr);
      notifications = [];
      unread_count = 0;
    }

    // 6) response payload
    // also include XP fields
    const [xpRow] = await pool.query(
      `SELECT xp, level, next_xp_target FROM teachers WHERE id = ?`,
      [teacherId]
    );

    return res.json({
      studentsCount,
      todayAttendanceCount,
      attendance7,
      notifications,
      unread_count,
      assignedBatches,
      xp: xpRow[0]?.xp ?? 0,
      level: xpRow[0]?.level ?? 1,
      next_xp_target: xpRow[0]?.next_xp_target ?? 250,
    });
  } catch (err) {
    console.error("GET /teachers/:id/dashboard (unexpected)", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/*
 GET /api/teachers/:id/students
 Return students assigned to teacher (via teacher_batches -> batches)
 Optional query: ?batch_id= - limit to a batch
 Sort roll_no numerically when possible
*/
router.get("/:id/students", auth, async (req, res) => {
  try {
    const teacherId = Number(req.params.id);
    const batchId = req.query.batch_id ? Number(req.query.batch_id) : null;

    // fetch assigned batch ids
    let q = `SELECT s.id, s.roll_no, s.name, s.email, s.course, s.batch_id, b.batch as std, b.year as batch_year
             FROM students s
             JOIN teacher_batches tb ON s.batch_id = tb.batch_id
             LEFT JOIN batches b ON s.batch_id = b.id
             WHERE tb.teacher_id = ?`;
    const params = [teacherId];
    if (batchId) {
      q += " AND s.batch_id = ?";
      params.push(batchId);
    }
    q += " ORDER BY " + ROLL_ORDER_SQL;
    const [rows] = await pool.query(q, params);
    return res.json(rows);
  } catch (err) {
    console.error("GET /teachers/:id/students", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/*
 Teacher-scoped attendance endpoints:
 GET /api/teachers/:id/attendance?date=YYYY-MM-DD&batch_id=...
 POST /api/teachers/:id/attendance  (teacher marks attendance for their batch)
*/
function isValidDateString(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(d).getTime());
}

async function teacherHasBatch(teacherId, batchId) {
  const [rows] = await pool.query(
    "SELECT 1 FROM teacher_batches WHERE teacher_id = ? AND batch_id = ? LIMIT 1",
    [teacherId, batchId]
  );
  return rows.length > 0;
}

// GET attendance for teacher
router.get("/:id/attendance", auth, async (req, res) => {
  try {
    const tid = Number(req.params.id);
    const user = req.user;
    const date = req.query.date;
    const batchId = req.query.batch_id ? Number(req.query.batch_id) : null;

    if (!date || !isValidDateString(date))
      return res.status(400).json({ message: "Invalid date" });
    if (!batchId) return res.status(400).json({ message: "batch_id required" });

    // permission
    if (!isAdmin(user) && !isSelf(user, tid))
      return res.status(403).json({ message: "Forbidden" });
    if (!isAdmin(user)) {
      const ok = await teacherHasBatch(tid, batchId);
      if (!ok)
        return res
          .status(403)
          .json({ message: "Forbidden: not assigned to batch" });
    }

    const [rows] = await pool.query(
      `SELECT a.student_id, a.status, a.recorded_by, s.roll_no, s.name, s.email, s.course, b.batch AS std, b.year AS batch_year
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       LEFT JOIN batches b ON s.batch_id = b.id
       WHERE a.attendance_date = ? AND s.batch_id = ? 
       ORDER BY ${ROLL_ORDER_SQL}`,
      [date, batchId]
    );
    return res.json(rows);
  } catch (err) {
    console.error("GET /teachers/:id/attendance", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST attendance for teacher (bulk upsert)
router.post("/:id/attendance", auth, async (req, res) => {
  try {
    const tid = Number(req.params.id);
    const user = req.user;
    const { date, batch_id, records } = req.body || {};

    if (!date || !isValidDateString(date))
      return res.status(400).json({
        message: "Validation failed",
        fields: { date: "Invalid date" },
      });
    if (!batch_id)
      return res.status(400).json({
        message: "Validation failed",
        fields: { batch_id: "batch_id required" },
      });
    if (!Array.isArray(records) || records.length === 0)
      return res.status(400).json({
        message: "Validation failed",
        fields: { records: "records must be non-empty array" },
      });

    // permission: teacher can only mark for their own batches, admin can mark any
    if (!isAdmin(user) && !isSelf(user, tid))
      return res.status(403).json({ message: "Forbidden" });
    if (!isAdmin(user)) {
      const ok = await teacherHasBatch(tid, batch_id);
      if (!ok)
        return res
          .status(403)
          .json({ message: "Forbidden: not assigned to batch" });
    }

    // validate student ids belong to batch
    const studentIds = records.map((r) => Number(r.student_id)).filter(Boolean);
    if (!studentIds.length)
      return res.status(400).json({
        message: "Validation failed",
        fields: { records: "student_id required" },
      });
    const [students] = await pool.query(
      "SELECT id FROM students WHERE id IN (?) AND batch_id = ?",
      [studentIds, batch_id]
    );
    const validStudentSet = new Set(students.map((s) => s.id));
    const invalids = studentIds.filter((sid) => !validStudentSet.has(sid));
    if (invalids.length)
      return res.status(400).json({
        message: "Validation failed",
        fields: { records: "Some student(s) not in selected batch" },
      });

    // build bulk upsert
    const values = [];
    const placeholders = [];
    for (const r of records) {
      const sid = Number(r.student_id);
      const status = String(r.status) === "Present" ? "Present" : "Absent";
      values.push(sid, date, status, user && user.id ? user.id : null);
      // store attendance_date as DATE(...) so time / timezone doesn't shift the day
      placeholders.push("(?, DATE(?), ?, ?)");
    }

    if (!values.length)
      return res.status(400).json({
        message: "Validation failed",
        fields: { records: "No valid records" },
      });

    const sql = `
      INSERT INTO attendance (student_id, attendance_date, status, recorded_by)
      VALUES ${placeholders.join(",")}
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        recorded_by = VALUES(recorded_by),
        updated_at = CURRENT_TIMESTAMP
    `;
    await pool.query(sql, values);
    // award XP for marking attendance
    // award XP for marking attendance
    try {
      console.log("[XP] awarding attendance XP ->", {
        tid,
        XP_ATTENDANCE,
        recordsCount: records.length,
      });
      await addTeacherXP(tid, XP_ATTENDANCE);
    } catch (e) {
      console.warn("XP update (attendance) failed:", e);
    }

    return res.json({ message: "Saved", count: records.length });
  } catch (err) {
    console.error("POST /teachers/:id/attendance", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/notifications/:nid/mark-read
// Marks a notification as read for the currently authenticated teacher
router.post("/notifications/:nid/mark-read", auth, async (req, res) => {
  try {
    const nid = Number(req.params.nid);
    const user = req.user;
    if (!nid)
      return res.status(400).json({ message: "Invalid notification id" });

    // allow only teachers here (or adjust if admin/student allowed)
    if (!user || user.role !== "teacher")
      return res.status(403).json({ message: "Forbidden" });

    // UPSERT: insert or update receipt for this teacher
    // This uses ON DUPLICATE KEY; recommended to have unique key on (notification_id, user_type, user_id)
    const sql = `
      INSERT INTO notification_receipts (notification_id, user_type, user_id, is_read, read_at)
      VALUES (?, 'teacher', ?, 1, NOW())
      ON DUPLICATE KEY UPDATE is_read = 1, read_at = NOW()
    `;
    await pool.query(sql, [nid, Number(user.id)]);
    return res.json({ message: "Marked read" });
  } catch (err) {
    console.error("mark-read error", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
