import type legalFr from "../fr/legal";
import type { Translation } from "../types";

const legalEn: Translation<typeof legalFr> = {
  document: {
    skipToContent: "Skip to content",
    version: "Version {{version}}, updated on {{date}}.",
    toc: "Contents",
    question:
      "A question about this text? <contact>Contact Stock Master</contact>",
  },
  documents: {
    "mentions-legales": {
      title: "Legal notice",
      short: "Legal notice",
      inSentence: "Legal notice",
    },
    "conditions-utilisation": {
      title: "Terms of Use",
      short: "Terms of Use",
      inSentence: "Terms of Use",
    },
    "conditions-abonnement": {
      title: "Subscription Terms",
      short: "Subscription Terms",
      inSentence: "Subscription Terms",
    },
    confidentialite: {
      title: "Privacy Policy",
      short: "Privacy",
      inSentence: "Privacy Policy",
    },
    cookies: {
      title: "Cookies and storage on your device",
      short: "Cookies and storage",
      inSentence: "Cookies and storage policy",
    },
    "traitement-donnees": {
      title: "Data Processing Agreement",
      short: "Data processing",
      inSentence: "Data Processing Agreement",
    },
  },
  acceptance: {
    prefix: "I have read and accept",
    article: "the",
    and: " and ",
    comma: ", ",
    newTab: "(new tab)",
    versions_one: "(version {{versions}})",
    versions_other: "(versions {{versions}})",
    notice:
      "To find out which data is processed and why, read the <doc></doc> (version {{version}}). It is for your information: reading it is not an agreement.",
    errors: {
      required: "Tick the box to accept the terms before continuing.",
      outdated:
        "The terms have been updated. Reload the page to read the new version, then try again.",
      mismatch:
        "The terms shown do not match the texts in force. Reload the page, then try again.",
      archive:
        "Your acceptance cannot be recorded at the moment. Try again in a few moments.",
    },
  },
  marketing: {
    label:
      "I would like to receive Stock Master offers and promotions by email. I can unsubscribe at any time.",
    optional:
      "Optional. Your account works the same way whether you tick this box or not.",
    errors: {
      outdated:
        "This text has been updated. Reload the page to see the new version.",
      unavailable:
        "Your choice couldn't be saved. Please try again in a moment.",
    },
    settings: {
      title: "Offers and promotions by email",
      text: "Choose whether you'd like to receive our offers by email. Emails about your account keep arriving whatever you choose.",
      grantedSince: "On since {{date}}.",
      notGranted: "You don't receive our offers by email.",
      previousAddress:
        "Your email address has changed. Tick the box if you'd like our offers at your new address.",
      unverified: "Confirm your email address to receive our offers.",
      granted: "Got it, you'll receive our offers.",
      withdrawn: "Got it, you won't receive our offers anymore.",
      unavailable: "This setting isn't available right now.",
      loading: "Loading…",
    },
  },
  unsubscribe: {
    metaTitle: "Unsubscribe",
    loading: "Loading…",
    title: "Unsubscribe from Stock Master offers",
    text: "You will no longer receive our offers and promotions by email.",
    confirm: "Unsubscribe me",
    submitting: "One moment…",
    service: "Emails about your account will keep arriving as usual.",
    doneTitle: "All set",
    doneText:
      "You won't receive our offers at this address anymore. You can change your mind at any time from your account.",
    invalidTitle: "This link no longer works",
    invalidText:
      "You can manage your preferences from your account, under Organisation then Notifications.",
    network: "The connection failed. Please try again.",
  },
  prompt: {
    title: "Your agreement is needed",
    description:
      "Before you continue using Stock Master, read the texts below. Your agreement is recorded only if you tick the box and confirm.",
    outdated:
      "New versions of the terms are in force. Reload the page to display them before giving your agreement.",
    notice:
      "For your information: <doc></doc> (version {{version}}). Reading it is not an agreement.",
    offline: "An Internet connection is needed to record your agreement.",
    recorded: "Your agreement has been recorded.",
    later: "Later",
    saving: "Saving…",
    accept: "I accept",
    reload: "Reload",
  },
  authLinks: {
    label: "Help and information",
    guide: "Guide",
    contact: "Contact",
    terms: "Terms of Use",
    subscriptionTerms: "Subscription Terms",
    privacy: "Privacy",
  },
};

export default legalEn;
