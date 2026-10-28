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

test('other insects on the trap are kept but never counted as pests', () => {
    const { OTHER_INSECT, NON_PEST_LABELS } = require('../src/constants/species');
    const { pestCountOf } = require('../src/models/Snapshot');
    const { countPests } = require('../src/services/notificationService');
    assert.equal(OTHER_INSECT, 'other_insect');
    assert.ok(NON_PEST_LABELS.includes(OTHER_INSECT));
    assert.ok(!isFruitFly(OTHER_INSECT));
    const summary = { fruit_fly: 4, other_insect: 7 };
    assert.equal(pestCountOf(summary), 4);
    assert.equal(countPests(summary), 4);
    assert.equal(countPests(new Map(Object.entries(summary))), 4);
});

test('pest count expression references MongoDB $$ variables correctly', () => {
    const { pestCountExpr } = require('../src/constants/species');
    const json = JSON.stringify(pestCountExpr());
    assert.ok(json.includes('"$$value"') && json.includes('"$$this.k"') && json.includes('"$$this.v"'));
    assert.ok(!/"\$value"|"\$this\./.test(json));
});
