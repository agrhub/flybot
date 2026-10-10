const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FRUIT_FLY, FRUIT_FLY_ALIASES, isFruitFly, normalizeSpeciesExpr } = require('../src/constants/species');

test('new data uses the English canonical key', () => {
    assert.equal(FRUIT_FLY, 'fruit_fly');
});

test('legacy fruit fly labels are still recognized', () => {
    for (const label of ['fruit_fly', 'Fruit Fly', 'fruit-fly', 'Bactrocera dorsalis', 'ruồi vàng', 'ruoi_vang']) {
        assert.ok(isFruitFly(label), label);
    }
    for (const label of ['moth', 'caterpillar', '', null]) {
        assert.ok(!isFruitFly(label), String(label));
    }
});

test('aggregation expression maps every alias to the canonical key', () => {
    assert.deepEqual(normalizeSpeciesExpr('$k'), {
        $cond: [{ $in: ['$k', FRUIT_FLY_ALIASES] }, FRUIT_FLY, '$k']
    });
    assert.ok(FRUIT_FLY_ALIASES.includes(FRUIT_FLY));
});
