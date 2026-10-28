/**
 * Species labels stored in Snapshot.aiResults (summary keys and insect names).
 *
 * New data always uses the canonical English key. Older snapshots stored the fruit fly
 * under other labels, including its Vietnamese name, so those stay listed as read-only
 * aliases until the data is migrated (see scripts/normalize_species.js).
 */
const FRUIT_FLY = 'fruit_fly';

// Legacy labels that all mean "fruit fly" ('ruồi vàng' / 'ruoi vang' are the Vietnamese name)
const FRUIT_FLY_ALIASES = ['fruit_fly', 'fruit fly', 'fruit-fly', 'bactrocera', 'ruồi vàng', 'ruoi vang'];

// Insects on the trap that are not the target fruit fly (Drosophila, bees, other bycatch): the
// detector's `other_insect` class, kept in the summary but never counted as a pest
const OTHER_INSECT = 'other_insect';

// Detection labels that are not pests and are excluded from statistics
// ('người' = "person", produced by older Vietnamese-language model output)
const NON_PEST_LABELS = ['car', 'bike', 'motocycle', 'motorcycle', 'person', 'người', 'truck', 'dog', 'cat', OTHER_INSECT];

function isFruitFly(label) {
    if (!label) return false;
    const s = String(label).toLowerCase();
    return FRUIT_FLY_ALIASES.some(alias => s.includes(alias)) || s.includes('ruoi');
}

/**
 * MongoDB aggregation expression mapping any fruit fly alias in `fieldPath` to FRUIT_FLY.
 */
function normalizeSpeciesExpr(fieldPath) {
    return {
        $cond: [{ $in: [fieldPath, FRUIT_FLY_ALIASES] }, FRUIT_FLY, fieldPath]
    };
}

/**
 * MongoDB aggregation expression: total pest count of a snapshot summary, ignoring non-pest labels.
 */
function pestCountExpr(summaryPath = '$aiResults.summary') {
    return {
        $reduce: {
            input: { $objectToArray: { $ifNull: [summaryPath, {}] } },
            initialValue: 0,
            in: {
                $add: ['$$value', {
                    $cond: [{ $in: [{ $toLower: '$$this.k' }, NON_PEST_LABELS] }, 0, { $ifNull: ['$$this.v', 0] }]
                }]
            }
        }
    };
}

module.exports = {
    pestCountExpr,
    FRUIT_FLY,
    FRUIT_FLY_ALIASES,
    OTHER_INSECT,
    NON_PEST_LABELS,
    isFruitFly,
    normalizeSpeciesExpr
};
