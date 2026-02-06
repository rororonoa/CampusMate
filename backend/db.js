const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, // ✅ FIXED
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,          // ✅ REQUIRED
  waitForConnections: true,
  connectionLimit: 10,
  ssl: {
    rejectUnauthorized: false          // ✅ REQUIRED for Railway
  }
});

module.exports = pool;
