/**
 * The expert review of FlyBot agent decisions (flybot-aws eval/EXPERT_REVIEW.md): the project's agronomy
 * advisor judges the 50 rows of docs/evidence/eval/expert_review.csv on the static page
 * client/public/review/<TOKEN>/, without an account. The token is the page's unguessable path, not a
 * secret: it keeps the page and its endpoint (routes/publicRoutes.js) out of reach of guessing.
 */
const TOKEN = 'd75w7dza2q88euh33ki5wuhx3f';

const ROW_IDS = [
    ...Array.from({ length: 15 }, (_, i) => `AWS-${String(i + 1).padStart(2, '0')}`),
    ...Array.from({ length: 12 }, (_, i) => `RPL-${String(i + 1).padStart(2, '0')}`),
    ...Array.from({ length: 8 }, (_, i) => `STG-${String(i + 1).padStart(2, '0')}`),
    ...Array.from({ length: 15 }, (_, i) => `FIJ-${String(i + 1).padStart(2, '0')}`)
];

const VERDICTS = ['correct', 'incorrect', 'unsure'];

module.exports = { TOKEN, ROW_IDS, VERDICTS };
