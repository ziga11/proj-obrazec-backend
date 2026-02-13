# Project Form Backend

Node.js service managing metadata persistence and cloud storage orchestration for project specifications.

## 📋 Overview
This backend service coordinates the data between the Project Form and cloud storage. It handles the lifecycle of project metadata and ensures that the physical storage architecture matches the database records.

## 🛠 Tech Stack
* **Runtime:** Node.js
* **Database:** PostgreSQL (NeonDB)
* **Cloud Storage:** Google Drive API

## ✨ Key Features
* **Transactional File Management:** Implements logic to ensure SQL records are only committed after successful cloud storage (Google Drive) provisioning.
* **Automated Directory Provisioning:** Automatically creates and organizes folder hierarchies for new projects.
* **Resource Cleanup:** Handles the synchronized deletion of database entries and associated cloud folders.
