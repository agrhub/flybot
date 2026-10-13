import { createRouter, createWebHistory } from 'vue-router';
import HomeLayout from '@/layouts/HomeLayout.vue';
import DefaultLayout from '@/layouts/DefaultLayout.vue';
import AuthLayout from '@/layouts/AuthLayout.vue';
import AppLayout from '@/layouts/AppLayout.vue';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior(to, _from, savedPosition) {
    if (to.hash) {
      return {
        el: to.hash,
        behavior: 'smooth',
        top: 80,
      };
    }
    if (savedPosition) {
      return savedPosition;
    }
    return { top: 0, behavior: 'smooth' };
  },
  routes: [
    // 1. Home Layout (Marketing Landing)
    {
      path: '/',
      component: HomeLayout,
      children: [
        {
          path: '',
          name: 'home',
          component: () => import('@/pages/Home.vue'),
        },
      ],
    },

    // 2. Default Layout (Static Pages)
    {
      path: '/',
      component: DefaultLayout,
      children: [
        {
          path: 'manual',
          name: 'manual',
          component: () => import('@/pages/Manual.vue'),
        },
        {
          path: 'terms',
          name: 'terms',
          component: () => import('@/pages/Terms.vue'),
        },
        {
          path: 'privacy',
          name: 'privacy',
          component: () => import('@/pages/Privacy.vue'),
        },
        {
          path: 'contact',
          name: 'contact',
          component: () => import('@/pages/Contact.vue'),
        },
      ],
    },

    // 3. Auth Layout (Authentication Pages)
    {
      path: '/auth',
      component: AuthLayout,
      children: [
        {
          path: 'login',
          name: 'login',
          component: () => import('@/pages/auth/Login.vue'),
        },
        {
          path: 'reset-password',
          name: 'reset-password',
          component: () => import('@/pages/auth/ResetPassword.vue'),
        },
        {
          path: 'verify-email',
          name: 'verify-email',
          component: () => import('@/pages/auth/VerifyEmail.vue'),
        },
      ],
    },
    {
      path: '/login',
      redirect: '/auth/login',
    },

    // 4. App Layout (Main Workspace Management)
    {
      path: '/',
      component: AppLayout,
      meta: { requiresAuth: true },
      children: [
        {
          path: 'dashboard',
          name: 'dashboard',
          component: () => import('@/pages/dashboard/index.vue'),
        },
        {
          path: 'cameras',
          name: 'cameras',
          component: () => import('@/pages/cameras/index.vue'),
        },
        {
          path: 'reports',
          name: 'reports',
          component: () => import('@/pages/dashboards/index.vue'),
        },
        {
          path: 'reports/:id',
          name: 'report-view',
          component: () => import('@/pages/dashboards/View.vue'),
        },
        // Reports were called dashboards: keep old links working
        { path: 'dashboards', redirect: '/reports' },
        { path: 'dashboards/:id', redirect: (to) => ({ path: `/reports/${to.params.id}`, query: to.query }) },
        {
          path: 'farms',
          name: 'farms',
          component: () => import('@/pages/farms/index.vue'),
        },
        {
          path: 'farms/:id',
          name: 'farm-view',
          component: () => import('@/pages/farms/View.vue'),
        },
        {
          path: 'logbook',
          name: 'logbook',
          component: () => import('@/pages/logbook/index.vue'),
        },
        {
          path: 'analytics',
          name: 'analytics',
          component: () => import('@/pages/analytics/index.vue'),
        },
        {
          path: 'map',
          name: 'map',
          component: () => import('@/pages/map/index.vue'),
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('@/pages/settings/index.vue'),
        },
      ],
    },

    // 5. Public dashboard link (read-only, no sign-in)
    {
      path: '/d/:token',
      name: 'public-dashboard',
      component: () => import('@/pages/public/PublicDashboard.vue'),
    },

    // Compatibility redirects for legacy URLs
    {
      path: '/dashboard/:tab',
      redirect: (to) => `/${to.params.tab}`,
    },

    // Fallback catch-all redirect to home
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});

// Navigation Guard for authentication
router.beforeEach((to, _from, next) => {
  const user = localStorage.getItem('user');
  if (to.meta.requiresAuth && !user) {
    next({ path: '/auth/login', query: { redirect: to.fullPath } });
  } else {
    next();
  }
});

export default router;
