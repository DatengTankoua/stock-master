import Link from "next/link";
import { MailLink } from "@/components/legal/mail-link";
import { LOCATIONS, SITE, WHATSAPP } from "@/lib/legal/site-identity";
import type { DocumentContent } from "@/i18n/documents/types";

// 1-16G — Page Contact en anglais (mêmes adresses, aucune ajoutée).
const content: DocumentContent = {
  metaTitle: "Contact",
  metaDescription:
    "Support, complaints and personal data requests for Stock Master.",
  title: "Contact Stock Master",
  intro: (
    <p>
      The easiest way: message us on WhatsApp. For a written request, choose the
      address that matches it: it goes straight to the right person.
    </p>
  ),
  sections: [
    {
      id: "whatsapp",
      title: "WhatsApp",
      content: (
        <>
          <p>
            <strong>Message us on WhatsApp at any time.</strong> We reply as
            soon as we can.
          </p>
          <ul>
            <li>
              WhatsApp:{" "}
              <a
                href={WHATSAPP.url}
                target="_blank"
                rel="noopener noreferrer"
                translate="no"
              >
                {WHATSAPP.display}
              </a>
            </li>
            <li>
              Phone:{" "}
              <a href={WHATSAPP.tel} translate="no">
                {WHATSAPP.display}
              </a>
            </li>
          </ul>
          <p>
            The conversation takes place in WhatsApp, outside {SITE.name}. Never
            share your password or a code received by text message or email.
          </p>
        </>
      ),
    },
    {
      id: "assistance",
      title: "Support",
      content: (
        <>
          <p>
            <strong>From the application:</strong> if your role allows it, open{" "}
            <strong>Organisation, then Support</strong>. Your message is sent
            with useful information about your account and your shop, and the
            reply arrives at your email address.
          </p>
          <p>
            <strong>By email:</strong>{" "}
            <MailLink to="support" subject="Support request" />, for example if
            you can no longer log in or access your shop. Include:
          </p>
          <ul>
            <li>
              the name of your shop and your account&apos;s email address;
            </li>
            <li>the screen concerned and what you tried;</li>
            <li>the type of device and browser.</li>
          </ul>
          <p>
            Never send your password: {SITE.name} will never ask you for it.
          </p>
          <p>
            The <Link href="/en/guide">user guide</Link> answers the most common
            questions.
          </p>
        </>
      ),
    },
    {
      id: "reclamations",
      title: "Complaints",
      content: (
        <p>
          To dispute a subscription period, a payment or how the service works:{" "}
          <MailLink to="support" subject="Complaint" />. Describe the facts, the
          dates and what you are asking for.
        </p>
      ),
    },
    {
      id: "donnees",
      title: "Personal data",
      content: (
        <>
          <p>
            To access your data, correct it, have it deleted or object to
            processing:{" "}
            <MailLink to="privacy" subject="Request about my data" />.
          </p>
          <p>
            Write from your account&apos;s address. The rights and how they work
            are detailed in the{" "}
            <Link href="/en/confidentialite">Privacy Policy</Link>.
          </p>
        </>
      ),
    },
    {
      id: "autres",
      title: "Other requests and locations",
      content: (
        <>
          <p>
            General questions and partnerships: <MailLink to="contact" />.
          </p>
          <p>Locations:</p>
          <ul>
            {LOCATIONS.map((location) => (
              <li key={location}>{location}</li>
            ))}
          </ul>
          <p>
            Automatic emails (address confirmation, password reset) are sent
            from an address on the <span translate="no">{SITE.domain}</span>{" "}
            domain. Do not reply to them: write to the addresses above instead.
          </p>
        </>
      ),
    },
  ],
};

export default content;
