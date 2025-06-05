// Temporary debug setup
process.env.DEBUG = 'express:*';
require('debug').enable('express:*');

const express = require('express');
const app = express();

// Verify Express installation
console.log('Express router exists?', !!express.Router);

app.get('/', (req, res) => {
  res.send('Server is working');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});