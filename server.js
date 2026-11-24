require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
  res.json({ status: 'NiameyFoncier API is live' });
});

app.get('/api/locations', async (req, res) => {
  try {
    const query = `
      SELECT 
        q.id AS quartier_id,
        q.arrondissement,
        q.nom_quartier,
        COALESCE(
          json_agg(
            json_build_object(
              'id', l.id,
              'nom_lotissement', l.nom_lotissement,
              'source_type', l.source_type,
              'promoteur_nom', l.promoteur_nom,
              'is_verified', l.is_verified
            )
          ) FILTER (WHERE l.id IS NOT NULL), '[]'
        ) AS lotissements
      FROM quartiers q
      LEFT JOIN lotissements l ON l.quartier_id = q.id
      GROUP BY q.id
      ORDER BY q.arrondissement, q.nom_quartier;
    `;
    const { rows } = await pool.query(query);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Database error fetching locations' });
  }
});

app.get('/api/parcelles/search', async (req, res) => {
  const { lotissement_id, ilot, parcelle, lat, lng } = req.query;

  if (!lotissement_id || !ilot || !parcelle) {
    return res.status(400).json({
      success: false,
      error: 'Veuillez fournir lotissement_id, ilot et parcelle.'
    });
  }

  const hasUserGPS = lat && lng && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));

  try {
    const query = `
      SELECT 
        p.id,
        p.ilot_num,
        p.parcelle_num,
        p.superficie_m2,
        p.statut_foncier,
        p.statut_vente,
        l.nom_lotissement,
        l.source_type,
        q.arrondissement,
        q.nom_quartier,
        ST_AsGeoJSON(p.geom)::json AS boundary_geojson,
        ST_Y(ST_Centroid(p.geom)) AS center_lat,
        ST_X(ST_Centroid(p.geom)) AS center_lng,
        COALESCE(
          json_agg(
            json_build_object(
              'code_borne', b.code_borne,
              'lat', ST_Y(b.point_geom),
              'lng', ST_X(b.point_geom),
              'utm_easting', b.utm_easting,
              'utm_northing', b.utm_northing,
              'distance_meters', ${
                hasUserGPS
                  ? `ROUND(ST_Distance(
                      b.point_geom::geography,
                      ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography
                    )::numeric, 1)`
                  : 'NULL'
              }
            ) ORDER BY b.code_borne
          ) FILTER (WHERE b.id IS NOT NULL), '[]'
        ) AS bornes
      FROM parcelles p
      JOIN lotissements l ON p.lotissement_id = l.id
      JOIN quartiers q ON l.quartier_id = q.id
      LEFT JOIN bornes b ON b.parcelle_id = p.id
      WHERE p.lotissement_id = $1
        AND LOWER(TRIM(p.ilot_num)) = LOWER(TRIM($2))
        AND LOWER(TRIM(p.parcelle_num)) = LOWER(TRIM($3))
      GROUP BY p.id, l.id, q.id;
    `;

    const params = hasUserGPS
      ? [lotissement_id, ilot, parcelle, parseFloat(lng), parseFloat(lat)]
      : [lotissement_id, ilot, parcelle];

    const { rows } = await pool.query(query, params);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Parcelle introuvable dans ce lotissement.'
      });
    }

    res.json({ success: true, parcelle: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Erreur lors de la recherche de parcelle.' });
  }
});

app.post('/api/parcelles/utm', async (req, res) => {
  const { lotissement_id, ilot_num, parcelle_num, statut_foncier, corners } = req.body;

  if (!corners || corners.length < 3) {
    return res.status(400).json({ success: false, error: 'Minimum 3 bornes requises.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ringPoints = [...corners, corners[0]]
      .map(c => `${parseFloat(c.easting)} ${parseFloat(c.northing)}`)
      .join(', ');
    const wktPolygon = `POLYGON((${ringPoints}))`;

    const insertParcelQuery = `
      INSERT INTO parcelles (lotissement_id, ilot_num, parcelle_num, statut_foncier, superficie_m2, geom)
      SELECT 
        $1, $2, $3, $4,
        ROUND(ST_Area(ST_GeomFromText($5, 32631))::numeric, 2),
        ST_Transform(ST_GeomFromText($5, 32631), 4326)
      RETURNING id, superficie_m2, ST_AsGeoJSON(geom)::json AS boundary_geojson;
    `;
    const parcelResult = await client.query(insertParcelQuery, [
      lotissement_id,
      ilot_num,
      parcelle_num,
      statut_foncier || 'ACTE_DE_CESSION',
      wktPolygon
    ]);
    const newParcel = parcelResult.rows[0];

    for (let i = 0; i < corners.length; i++) {
      const c = corners[i];
      const code = c.code || `B${i + 1}`;
      await client.query(
        `INSERT INTO bornes (parcelle_id, code_borne, utm_easting, utm_northing, point_geom)
         VALUES ($1, $2, $3, $4, ST_Transform(ST_SetSRID(ST_MakePoint($3, $4), 32631), 4326))`,
        [newParcel.id, code, parseFloat(c.easting), parseFloat(c.northing)]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, parcelle: newParcel });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/parcelles/upload-geojson', upload.single('file'), async (req, res) => {
  const { lotissement_id } = req.body;
  if (!req.file || !lotissement_id) {
    return res.status(400).json({ success: false, error: 'Fichier GeoJSON et lotissement_id requis.' });
  }

  const client = await pool.connect();
  try {
    const geojson = JSON.parse(req.file.buffer.toString('utf8'));
    const features = geojson.features || [];
    let importedCount = 0;

    await client.query('BEGIN');

    for (const feature of features) {
      const props = feature.properties || {};
      const ilot = props.ilot || props.ILOT || '1';
      const parcelle = props.parcelle || props.PARCELLE || props.num;
      if (!parcelle || !feature.geometry) continue;

      const geomString = JSON.stringify(feature.geometry);

      const resParcel = await client.query(
        `INSERT INTO parcelles (lotissement_id, ilot_num, parcelle_num, statut_foncier, superficie_m2, geom)
         VALUES (
           $1, $2, $3, $4,
           ROUND(ST_Area(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)::geography)::numeric, 2),
           ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)
         )
         ON CONFLICT (lotissement_id, ilot_num, parcelle_num) DO NOTHING
         RETURNING id`,
        [lotissement_id, String(ilot), String(parcelle), props.statut || 'ACTE_DE_CESSION', geomString]
      );

      if (resParcel.rows.length > 0) {
        importedCount++;
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, imported: importedCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, error: 'Erreur lors de l’import GeoJSON.' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`NiameyFoncier API running on port ${PORT}`));
