Perfect, thanks 👍
Based on everything you shared, here is a **clean, professional `README.md`** you can **directly copy-paste** into your repo.

---

```md
# 🎓 CampusMate – Smart Student Management System

CampusMate is a **role-based Student Management System** designed to digitize and simplify academic operations for colleges and schools.  
It provides **separate portals** for **Admin**, **Teachers**, and **Students**, each with a distinct UI and controlled access.

This project is developed as a **Final Year Project** and is also suitable for **portfolio showcase**.

---

## 🚀 Features

### 👨‍💼 Admin Portal
- Secure admin login
- Manage teachers and students
- Create and manage batches & courses
- Assign teachers to batches
- Send notifications to students and teachers
- View overall system data

### 👨‍🏫 Teacher Portal
- Secure teacher login
- View assigned students and batches
- Mark and manage student attendance
- Enter and update marks
- Create, edit, and manage assignments
- Review student submissions and give feedback
- View notifications and profile details

### 👨‍🎓 Student Portal
- Secure student login
- View attendance with performance indicators
- View marks and academic performance
- View and submit assignments
- Receive notifications and announcements
- Manage profile and change password

---

## 🔐 Authentication & Security
- JWT (JSON Web Token) based authentication
- Role-based access control (Admin / Teacher / Student)
- Protected routes on frontend
- Passwords stored securely using hashing

---

## 🛠 Tech Stack

### Frontend
- HTML5
- CSS3
- JavaScript (Plain JS)
- Bootstrap 5

### Backend
- Node.js
- Express.js
- MySQL

### Other Tools & Libraries
- JWT (jsonwebtoken)
- bcrypt
- dotenv
- multer
- express-validator

---

## 📂 Project Structure (Single Repository)

```

campusmate/
│
├── backend/
│   ├── routes/
│   ├── controllers/
│   ├── middleware/
│   ├── server.js
│   └── package.json
│
├── frontend/
│   ├── admin/
│   ├── teacher/
│   └── student/
│
├── screenshots/
│
├── .gitignore
└── README.md

````

---

## 📸 Screenshots

> Add screenshots inside the `screenshots/` folder and reference them like this:

### Admin Dashboard
![Admin Dashboard](screenshots/admin-dashboard.png)

### Teacher Dashboard
![Teacher Dashboard](screenshots/teacher-dashboard.png)

### Student Dashboard
![Student Dashboard](screenshots/student-dashboard.png)

---

## ⚙️ Setup Instructions (Local)

### 1️⃣ Clone Repository
```bash
git clone https://github.com/your-username/campusmate.git
cd campusmate
````

### 2️⃣ Backend Setup

```bash
cd backend
npm install
```

Create a `.env` file:

```env
DB_HOST=
DB_USER=
DB_PASSWORD=
DB_NAME=
JWT_SECRET=
```

Run backend:

```bash
npm run dev
```

### 3️⃣ Frontend Setup

* Open frontend files using **Live Server**
* Ensure API base URL matches backend server

---

## 🎯 Project Purpose

* Final Year Academic Project
* Real-world college management simulation
* Portfolio-ready full-stack application

---

## 👤 Author

**Sumeet Shetty**
Final Year Student – BCA

---

## 📜 License

This project is licensed under the **MIT License**.
