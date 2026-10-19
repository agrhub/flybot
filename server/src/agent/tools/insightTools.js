const { Farm, Treatment } = require('../../models');
const { viewableCameras, getViewableSerials } = require('../../utils/ownership');
const treatmentService = require('../../services/treatmentService');
const farmService = require('../../services/farmService');
const farmCompareService = require('../../services/farmCompareService');
const degreeDayService = require('../../services/degreeDayService');
const { orgRolesOf } = require('../../services/orgService');

const DAY_MS = 24 * 60 * 60 * 1000;

// Farm access is checked from the user's organizations, as on the Farms pages
async function withOrgRoles(user) {
    if (user.orgRoles) return user;
    // farmViewFilter only reads the id, the role, the organization roles and the demo access
    return { _id: user._id, id: user.id, role: user.role, demoSerials: user.demoSerials, demoOrgId: user.demoOrgId, orgRoles: await orgRolesOf(user) };
}

// ---------- Effect by active ingredient ----------

const getTreatmentEffectivenessDeclaration = {
    name: 'get_treatment_effectiveness',
    description: 'Which pesticides / active ingredients worked best on this farm, across all their uses: uses, how many could be measured, average change in flies per trap per day in the 7 days after, and how many uses clearly worked (a drop of 30% or more). For "which spray works best", "is abamectin still effective".',
    parameters: {
        type: 'OBJECT',
        properties: {
            months: { type: 'NUMBER', description: 'How far back to look (default 12, at most 24)' }
        }
    }
};

async function executeGetTreatmentEffectiveness({ months = 12, userId, user }) {
    if (!userId) return { error: 'Not authenticated.' };
    const span = Math.max(1, Math.min(Number(months) || 12, 24));
    const visible = new Set(await getViewableSerials(user));
    if (!visible.size) return { months: span, ingredients: [], note: 'No cameras.' };
    const treatments = await Treatment.find({ cameraSerials: { $in: [...visible] }, at: { $gte: new Date(Date.now() - span * 30 * DAY_MS) } })
        .sort({ at: -1 }).limit(200).lean();
    const ingredients = await treatmentService.effectivenessByIngredient(treatments, visible);
    return {
        months: span,
        ingredients: ingredients.map(g => ({
            activeIngredient: g.name,
            products: g.products,
            uses: g.uses,
            measured: g.measured,
            averageChangePct: g.avgChangePct,
            clearlyWorked: g.effective,
            lastUsed: g.lastAt
        })),
        note: 'averageChangePct: negative means fewer flies after the treatment. Uses less than 2 days old or without data are not in the average.'
    };
}

// ---------- Farms side by side ----------

const compareFarmsDeclaration = {
    name: 'compare_farms',
    description: 'The user\'s farms (and their plots) side by side: flies per trap per day over the last N days against the N days before, the worst plot and how many treatments were logged. For "which farm is worst", "compare my farms / growers".',
    parameters: {
        type: 'OBJECT',
        properties: {
            days: { type: 'NUMBER', description: 'Period in days: 7, 30 (default) or 90' }
        }
    }
};

async function executeCompareFarms({ days = 30, userId, user }) {
    if (!userId) return { error: 'Not authenticated.' };
    const withRoles = await withOrgRoles(user);
    const farms = await Farm.find(farmService.farmViewFilter(withRoles)).select('name').lean();
    if (!farms.length) return { note: 'No farms yet: farms are created on the Farms page.' };
    const visible = new Set(await getViewableSerials(user));
    const result = await farmCompareService.compareFarms(farms, visible, Number(days) || 30);
    return {
        periodDays: result.period,
        farms: result.farms.map(f => ({
            farm: f.name,
            traps: f.traps,
            fliesPerTrapPerDay: f.ftd,
            previousPeriod: f.previousFtd,
            changePct: f.changePct,
            worstPlot: f.worstPlot ? { plot: f.worstPlot.name, fliesPerTrapPerDay: f.worstPlot.ftd, changePct: f.worstPlot.changePct } : null,
            plots: f.plots.map(p => ({ plot: p.name, traps: p.traps, fliesPerTrapPerDay: p.ftd, changePct: p.changePct })),
            treatments: f.treatments
        }))
    };
}

// ---------- Weather outlook ----------

const getWeatherOutlookDeclaration = {
    name: 'get_weather_outlook',
    description: 'The next 3 days\' weather at the traps (temperature, humidity, rain) and which days suit fruit flies, with the next wave of adults from degree-days. level: high (suitable days as a wave is due), elevated (suitable days), low. For "will the weather favor fruit flies", "should I spray before the weekend".',
    parameters: {
        type: 'OBJECT',
        properties: {
            farm: { type: 'STRING', description: 'A farm name, to use its traps (optional; default: all the user\'s traps)' }
        }
    }
};

async function executeGetWeatherOutlook({ farm, userId, user }) {
    if (!userId) return { error: 'Not authenticated.' };
    let cameras = await viewableCameras(user).select('deviceSerial deviceName latitude longitude trapKind farmId').lean();
    if (farm) {
        const withRoles = await withOrgRoles(user);
        const farms = await Farm.find(farmService.farmViewFilter(withRoles)).select('name').lean();
        const wanted = farms.find(f => f.name.toLowerCase() === String(farm).trim().toLowerCase());
        if (!wanted) return { error: `No farm named "${farm}". Farms: ${farms.map(f => f.name).join(', ') || 'none'}.` };
        cameras = cameras.filter(c => String(c.farmId) === String(wanted._id));
    }
    if (!cameras.some(c => Number.isFinite(c.latitude) && Number.isFinite(c.longitude))) {
        return { note: 'No trap with a GPS location: set one on the camera to get the weather.' };
    }
    const model = await degreeDayService.forCameras(cameras);
    if (!model?.outlook) return { note: 'The weather forecast is not available right now.' };
    return {
        level: model.outlook.level,
        favorableDays: model.outlook.favorableDays,
        days: model.outlook.days.map(d => ({ day: d.day, minC: d.min, maxC: d.max, humidityPct: d.humidity, rainMm: d.rain, suitsFruitFlies: d.favorable })),
        nextWave: model.nextWave ? { date: model.nextWave.date, inDays: model.nextWave.inDays, estimated: model.nextWave.estimated } : null,
        note: 'A day suits fruit flies at a 25-33 °C mean, 70% humidity or more and no heavy rain (20 mm or more).'
    };
}

const getSprayPlanDeclaration = {
    name: 'get_spray_plan',
    description: 'What to do next on each plot, from the traps, the logged treatments, the next fly generation (degree-days) and the rain forecast: treat_now (traps at threshold, nothing in the past week; on the first day without heavy rain), wait_check (treated less than 7 days ago: check its effect after waitUntil), bait_before_wave (a generation due within 10 days: bait a few days before), sanitation (weather favors flies: collect fallen fruit), monitor. rotateFrom: the active ingredient used in the last two sprays, to change next time. For "when should I spray", "what should I do this week".',
    parameters: { type: 'OBJECT', properties: {} }
};

async function executeGetSprayPlan({ userId, user }) {
    if (!userId) return { error: 'Not authenticated.' };
    const plan = await require('../../services/sprayPlanService').planFor(user);
    if (!plan.items.length) return { note: 'No trap is in a farm yet: assign the traps to farms and plots first.' };
    return {
        today: plan.today,
        plots: plan.items.map(i => ({
            farm: i.farm, plot: i.plot, traps: i.traps, trapsAtThreshold: i.atThreshold, fliesPerTrapPerDay7: i.ftd7,
            action: i.action, date: i.date, waitUntil: i.waitUntil, movedForRain: i.rainMoved, rotateFrom: i.rotateFrom,
            lastTreatment: i.lastTreatment, nextWave: i.wave
        })),
        note: 'Suggestions from simple rules; the grower decides. Follow the product label (dose, pre-harvest interval).'
    };
}

module.exports = {
    insightDeclarations: [
        getSprayPlanDeclaration,
        getTreatmentEffectivenessDeclaration,
        compareFarmsDeclaration,
        getWeatherOutlookDeclaration
    ],
    insightExecutors: {
        get_spray_plan: executeGetSprayPlan,
        get_treatment_effectiveness: executeGetTreatmentEffectiveness,
        compare_farms: executeCompareFarms,
        get_weather_outlook: executeGetWeatherOutlook
    }
};
