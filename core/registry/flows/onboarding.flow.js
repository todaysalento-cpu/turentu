export const onboardingFlow = {
  id: "onboarding",

  initial: "profilo",

  steps: {
    profilo: {
      id: "profilo",
      order: 1,
      route: "/autista/onboarding/profilo",

      meta: {
        title: "Profilo",
        description: "Dati personali e documenti",
      },

      transitions: {
        NEXT: "veicolo",
      },

      guards: {
        enter: (ctx) => {
          return Boolean(ctx?.userId);
        },

        exit: (ctx) => {
          return Boolean(ctx?.data?.profiloCompleto);
        },
      },
    },

    veicolo: {
      id: "veicolo",
      order: 2,
      route: "/autista/onboarding/veicolo",

      meta: {
        title: "Veicolo",
      },

      transitions: {
        NEXT: "tariffe",
        BACK: "profilo",
      },

      guards: {
        enter: (ctx) => {
          return Boolean(ctx?.data?.profiloOk);
        },

        exit: (ctx) => {
          return Boolean(ctx?.data?.veicoloOk);
        },
      },
    },

    tariffe: {
      id: "tariffe",
      order: 3,
      route: "/autista/onboarding/tariffe",

      meta: {
        title: "Tariffe",
      },

      transitions: {
        NEXT: "disponibilita",
        BACK: "veicolo",
      },

      guards: {
        enter: (ctx) => {
          return Boolean(ctx?.data?.veicoloOk);
        },

        exit: (ctx) => {
          return Boolean(ctx?.data?.tariffeOk);
        },
      },
    },

    disponibilita: {
      id: "disponibilita",
      order: 4,
      route: "/autista/onboarding/disponibilita",

      meta: {
        title: "Disponibilità",
      },

      transitions: {
        NEXT: "finish",
        BACK: "tariffe",
      },

      guards: {
        enter: (ctx) => {
          return Boolean(ctx?.data?.tariffeOk);
        },

        exit: (ctx) => {
          return Boolean(ctx?.data?.disponibilitaOk);
        },
      },
    },

    finish: {
      id: "finish",
      order: 5,
      route: "/autista/onboarding/finish",

      meta: {
        title: "Completato",
        final: true,
      },

      transitions: {
        NEXT: null,
        BACK: "disponibilita",
      },

      guards: {
        enter: () => true,
        exit: () => true,
      },
    },
  },

  /* ================= HELPER (NEW) ================= */

  getInitialStep() {
    return this.initial;
  },

  getStep(stepId) {
    return this.steps?.[stepId] ?? null;
  },

  isFinal(stepId) {
    return !!this.steps?.[stepId]?.meta?.final;
  },

  resolveTransition(currentStep, action) {
    const step = this.steps?.[currentStep];
    if (!step) return null;

    return step.transitions?.[action] ?? null;
  },
};