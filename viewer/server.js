const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const ASSETS = path.resolve(__dirname, '..');

app.use(express.static(path.join(__dirname, 'public')));
app.use('/lib', express.static(path.join(__dirname, 'lib')));

// Serve ckassets files for the sidebar browser
app.use('/ckassets', express.static(ASSETS));

// List files in an assets subfolder
app.get('/api/assets', (req, res) => {
  const folder = req.query.folder || 'maps';
  const dir = path.join(ASSETS, folder);
  if (!dir.startsWith(ASSETS)) return res.status(400).json({ error: 'bad path' });
  try {
    const files = fs.readdirSync(dir)
      .filter(f => /\.(webp|png|jpg|jpeg)$/i.test(f) && !f.startsWith('.'))
      .sort();
    res.json({ folder, files });
  } catch {
    res.status(404).json({ error: 'folder not found' });
  }
});

// Save a processed image blob back into ckassets.
// Optional ?oldName= causes the previous file to be deleted when the name changes.
app.post('/api/save', express.raw({ type: () => true, limit: '50mb' }), (req, res) => {
  const folder  = req.query.folder || 'maps';
  const name    = req.query.name;
  const oldName = req.query.oldName;
  if (!name || !/^[^/\\]+\.(webp|png)$/i.test(name)) {
    return res.status(400).json({ error: 'invalid filename' });
  }
  const dest = path.join(ASSETS, folder, name);
  if (!dest.startsWith(ASSETS + path.sep)) return res.status(400).json({ error: 'bad path' });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, req.body);
  if (oldName && oldName !== name) {
    const old = path.join(ASSETS, folder, oldName);
    if (old.startsWith(ASSETS + path.sep) && fs.existsSync(old)) fs.unlinkSync(old);
  }
  res.json({ ok: true, saved: `${folder}/${name}` });
});

app.listen(3000, () => console.log('Listening: http://localhost:3000'));
