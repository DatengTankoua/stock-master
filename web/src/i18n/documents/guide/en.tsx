import Link from "next/link";
import { MailLink } from "@/components/legal/mail-link";
import { SITE, WHATSAPP } from "@/lib/legal/site-identity";
import { TRIAL_DAYS } from "@/lib/subscription-offers";
import type { DocumentContent } from "@/i18n/documents/types";

// 1-16G — Guide d'utilisation en anglais. Les noms des boutons sont ceux de
// l'interface anglaise (ressources `i18n/resources/en/*`).
const registrationEnabled =
  process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";

const content: DocumentContent = {
  metaTitle: "User guide",
  metaDescription:
    "Sign-up, members, products, batches and expiry, losses, sales, analytics, trash, offline, subscription, notifications and WhatsApp support: the Stock Master step-by-step guide.",
  title: "User guide",
  intro: (
    <>
      <p>
        This guide explains, step by step, how to use {SITE.name} in your shop.
        Button names are written as they appear in the application.
      </p>
      <p className="mt-3">
        Looking first for a method to organise your stock? Read{" "}
        <Link href="/en/guides/gestion-stock-boutique">
          How to manage stock in a shop
        </Link>
        .
      </p>
    </>
  ),
  sections: [
    {
      id: "inscription",
      title: "Sign up and confirm your email address",
      content: (
        <>
          {!registrationEnabled && (
            <p>
              <strong>Online sign-ups are temporarily closed.</strong> The steps
              below will apply when they reopen. An invited seller can still
              join a shop (see the next section).
            </p>
          )}
          <ol>
            <li>
              Open the{" "}
              {registrationEnabled ? (
                <Link href="/auth/register">Sign up</Link>
              ) : (
                "Sign up"
              )}{" "}
              page and enter your name, your email address, a password of 6 to
              100 characters and the name of your shop (20 characters at most).
            </li>
            <li>
              Read and then accept the{" "}
              <Link href="/en/conditions-utilisation">Terms of Use</Link> and
              the{" "}
              <Link href="/en/conditions-abonnement">Subscription Terms</Link>{" "}
              by ticking the box provided: the account is not created without
              it.
            </li>
            <li>
              A confirmation email is sent to you. Open the link it contains
              within 24 hours.
            </li>
            <li>
              You can then <Link href="/auth/login">log in</Link>. The{" "}
              {TRIAL_DAYS}-day free trial started when the shop was created.
            </li>
          </ol>
          <h3>Log in</h3>
          <p>
            Open <Link href="/auth/login">Log in</Link> and enter your email
            address and password. If you belong to several shops, choose the one
            to open. If the shop&apos;s subscription has ended, a screen says
            so: the owner can renew from that screen.
          </p>
          <p>
            No email? Check your spam folder, then try to log in: the login
            screen then offers to send the link again. If you forget your
            password, use “Forgot your password?”: the link you receive is valid
            for 1 hour.
          </p>
        </>
      ),
    },
    {
      id: "membres",
      title: "Create your shop, invite members, choose their rights",
      content: (
        <>
          <p>
            Your shop is created when you sign up, and you are its owner. In{" "}
            <strong>Organisation</strong>, you can change its name, logo and
            colour (Branding), and manage the team.
          </p>
          <h3>Invite a member</h3>
          <ol>
            <li>
              Open <strong>Organisation, then Invitations</strong>, and create
              an invitation with the person&apos;s email address, role and
              rights.
            </li>
            <li>
              Copy the link shown and send it yourself, by text message or a
              messaging app. {SITE.name} does not send the invitation by email.
              The link is shown only once and stays valid for 72 hours.
            </li>
            <li>
              The person opens the link and creates their access. If they do not
              have an account yet, they accept the Terms of Use by ticking the
              box provided.
            </li>
          </ol>
          <h3>Roles and rights</h3>
          <ul>
            <li>
              <strong>Owner</strong>: all rights, subscription and transfer of
              ownership.
            </li>
            <li>
              <strong>Administrator</strong>: all rights except those specific
              to the owner.
            </li>
            <li>
              <strong>Seller</strong>: records sales and sees their own. You can
              add other rights one by one (see all sales, manage the catalogue,
              adjust stock, view analytics, contact customer support…).
            </li>
          </ul>
          <p>
            Stock-related rights are also given one by one: “Manage expiry
            dates”, “Customise stock thresholds”, “Enable batch tracking and
            split existing stock”, “Set a batch aside and make it available
            again”, “Record and correct stock losses” and “Set the expiry alert
            lead time”. The owner and administrators have them all; a seller has
            none until you tick them.
          </p>
          <p>
            <strong>An option is missing?</strong> A button or a field only
            appears if your role or rights allow it. Ask the owner or an
            administrator for the matching right.
          </p>
          <p>
            In <strong>Organisation, then Members</strong>, choose “Edit” on a
            member to change their rights or status: “Suspended” removes access
            temporarily, “Revoked” removes it permanently. The owner can also
            “Transfer ownership” to another member.
          </p>
        </>
      ),
    },
    {
      id: "catalogue",
      title: "Products, categories, stock, sales and analytics",
      content: (
        <>
          <h3>Organise products by category</h3>
          <p>
            In <strong>Catalogue</strong>, create your categories with “New
            section” (for example Drinks, Groceries). A category can contain
            sub-categories.
          </p>
          <h3>Add a product</h3>
          <p>
            Open a category, then add a product: name, photo, purchase price,
            sale price and initial quantity (in FCFA). The photo is required.
          </p>
          <p>Two fields are optional, depending on your rights:</p>
          <ul>
            <li>
              <strong>Expiry date</strong> (“Manage expiry dates” right): one
              date for the whole product, for a product without batches. It is
              for information: <strong>it never blocks sales</strong>, even once
              passed (the product page then shows it as “passed”). It is used
              for expiry alerts. To track several dates for one product, enable{" "}
              <a href="#lots">batch tracking</a>.
            </li>
            <li>
              <strong>Low-stock threshold</strong> (“Customise stock thresholds”
              right): the product shows “Low stock” when the remaining quantity
              is below this threshold. Empty: default rule (20% or less of the
              initial stock, additions included). 0: only out of stock is
              reported.
            </li>
          </ul>
          <p>
            In “Edit”, “Remove the date” and “Use the default rule” clear these
            values.
          </p>
          <h3>Track and top up stock</h3>
          <ul>
            <li>
              Each sale lowers the product&apos;s stock. The product page shows
              “In stock”, “Low stock” or “Out of stock”, and the threshold
              applied (custom or default).
            </li>
            <li>
              To add goods, choose “Edit” on the product and fill in “Additional
              stock to add” (“Adjust stock” right).
            </li>
            <li>
              Product tracked by batches: this field no longer appears. Record
              new units from the product&apos;s “Batches” section (see{" "}
              <a href="#lots">Batches, expiry and losses</a>).
            </li>
          </ul>
          <h3>Record a sale</h3>
          <ol>
            <li>Open the product in the catalogue.</li>
            <li>Choose “Sell”: the “Record a sale” window opens.</li>
            <li>
              Enter the quantity and the actual sale price. The buyer&apos;s
              name and contact details are optional: only enter them if your
              shop needs them.
            </li>
            <li>
              Product tracked by batches: also check the “Batches given to the
              customer” (see <a href="#lots">below</a>).
            </li>
            <li>
              Choose “Confirm the sale”. The sale appears in{" "}
              <strong>Sales</strong>.
            </li>
          </ol>
          <p>
            A sale can be corrected or deleted later, depending on your rights.
            Deleting a sale puts the quantity back in stock.
          </p>
          <h3>Understand your business</h3>
          <p>
            <strong>Analytics</strong> (“View analytics” right) shows the
            capital invested, revenue, profit, margin, units sold, the monthly
            trend and the product and seller rankings. A summary of the past
            month is also produced at the start of each month.
          </p>
          <p>
            When a month is chosen, the card becomes “Estimated gain for the
            month”: amount of the month&apos;s sales minus the current purchase
            price of the products sold that month (price kept when a product is
            deleted). If this price is unknown for a sale of the month, the gain
            is shown as “—” rather than wrong.
          </p>
          <h3>Download a month&apos;s history</h3>
          <ul>
            <li>
              The owner and the administrator find, at the top of{" "}
              <strong>Analytics</strong>, the “Monthly history” block: choose a
              month, then “Download as Excel” or “Download as PDF”.
            </li>
            <li>
              The file contains a summary of the month, all sales (date,
              product, quantity, price, amount, seller, buyer), a summary by
              product and by seller, and the month&apos;s sale corrections and
              cancellations.
            </li>
            <li>
              The figures follow the same rules as the Analytics screen. A
              product&apos;s name is the one recorded at the time of the sale,
              even if it has since been renamed or deleted. An unknown value is
              shown as “Information unavailable”, never zero.
            </li>
            <li>
              Sales still waiting to be synchronised on a device are not
              included: synchronise them before downloading.
            </li>
            <li>
              The PDF reproduces names exactly (accents, œ and apostrophes
              included). If a name contains characters it cannot reproduce
              (another alphabet, emoji…), it is refused with a message: then
              download the Excel file, which keeps names exactly.
            </li>
            <li>
              Downloading needs an Internet connection. The file contains
              information about buyers: keep it somewhere safe.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "lots",
      title: "Batches, expiry and losses",
      content: (
        <>
          <p>
            Batch tracking is for products whose deliveries do not share the
            same expiry date. Each batch has its quantity, its date (optional)
            and its number. Everything happens in the product&apos;s “Batches”
            section.
          </p>
          <h3>Enable batch tracking</h3>
          <ol>
            <li>
              On the product page, “Batches” section, choose “Enable batch
              tracking” (“Enable batch tracking and split existing stock”
              right).
            </li>
            <li>
              Split the current stock: “I know the split: one line per batch”
              (quantity, then optional expiry date and manufacturer batch
              number), or “I don&apos;t know the split: one historical batch,
              unknown date”.
            </li>
            <li>
              The total must be exactly the stock shown. Tick the confirmation,
              then “Confirm the split”.
            </li>
          </ol>
          <p>
            Result: the product page shows “Stock tracking: By batches”. This is
            neither a sale nor a stock entry: the total does not change. The
            batches&apos; dates replace the product&apos;s single date (“Use the
            product sheet date” offers it line by line, never automatically).{" "}
            <strong>Batch tracking cannot be turned off.</strong> If a sale
            happened while you were entering the split, a message asks you to
            refresh the product and split again.
          </p>
          <h3>Receive goods</h3>
          <ul>
            <li>
              “New batch”: quantity received, date received, expiry date and
              manufacturer number (“Manage products” and “Adjust stock” rights).
            </li>
            <li>
              “Receive” on an existing batch: only the quantity is added
              (“Adjust stock” right).
            </li>
          </ul>
          <h3>Sell a product tracked by batches</h3>
          <ol>
            <li>
              In “Record a sale”, the “Batches given to the customer” part
              suggests a split, nearest expiry first.
            </li>
            <li>
              Adjust it to the units <strong>actually handed over</strong>: the
              batches must add up to the quantity sold. Nothing is reserved
              before confirmation.
            </li>
            <li>
              “Confirm the sale”. The sale keeps the batches chosen; the server
              never replaces them. If a batch no longer has enough units, the
              window stays open and suggests a new split.
            </li>
          </ol>
          <ul>
            <li>
              <strong>Batches without a date</strong>: listed separately, never
              suggested. To sell them, tick “I confirm selling units whose
              expiry date is unknown.”
            </li>
            <li>
              <strong>Expired batch</strong>: no longer offered and{" "}
              <strong>can no longer be sold</strong>, even if made available
              again.
            </li>
          </ul>
          <h3>Physical stock and sellable stock</h3>
          <p>
            <strong>Expiry alone does not remove stock.</strong> Units of an
            expired or set-aside batch stay in the physical stock (the
            “Remaining stock”) until a loss is recorded. The “Batches” section
            separates “Sellable today” from the stock that cannot be sold. The
            low-stock threshold is calculated on the total physical stock,
            expired batches included.
          </p>
          <p>
            On a product <strong>without batches</strong>, on the other hand,
            the expiry date does not block sales.
          </p>
          <h3>Set a batch aside</h3>
          <p>
            “Set aside” (“Set a batch aside and make it available again” right)
            takes the <strong>whole</strong> batch out of sale, with a required
            reason, for example while waiting for a check. No unit leaves the
            stock. “Make available” makes it sellable again, unless it has
            expired.
          </p>
          <h3>Record and correct a loss</h3>
          <ol>
            <li>
              On a batch, “Record a loss” (“Record and correct stock losses”
              right).
            </li>
            <li>
              Enter the quantity lost and the reason: “Expiry”, “Breakage or
              damage” or “Other” (comment required). Tick the confirmation, then
              “Record the loss”.
            </li>
          </ol>
          <p>
            Result: the units leave the stock.{" "}
            <strong>A loss is never a sale</strong>: no revenue, no units sold.
            It appears in “Loss history” and in Analytics. Losing all the
            remaining stock of a batch closes it (“Withdrawn”).
          </p>
          <p>
            Entered by mistake? In the loss history, “Correct” gives units back
            to the same batch, with a reason. The original loss stays visible,
            and the batch keeps its state: putting it back on sale is a separate
            step.
          </p>
          <h3>Expiry alerts</h3>
          <ul>
            <li>
              Two notification categories: “Expiry approaching” (the batch or
              product enters the alert period) and “Expired products” (date
              passed). Each is sent once per expiry date, for products still in
              stock, to members with the “See stock details” right.
            </li>
            <li>
              They cover batches and products without batches that have a date.
              A date is valid on the day itself; it has passed the next day,
              according to the shop&apos;s day.
            </li>
            <li>
              The lead time is set in <strong>Analytics</strong>, “Expiry and
              losses” block, “Alert lead time (days)” field (“Set the expiry
              alert lead time” right): 0 to 365 days, 30 by default. 0 means an
              alert on the expiry day itself, not turning alerts off.
            </li>
            <li>
              This block also lists what is “Expiring soon”, what has “Expired”
              and the “Losses this month”.
            </li>
          </ul>
          <p>Setting batches aside and losses need an Internet connection.</p>
        </>
      ),
    },
    {
      id: "corbeille",
      title: "Trash, permanent deletion and sales history",
      content: (
        <>
          <ul>
            <li>
              Deleting a product or a category puts it in the{" "}
              <strong>Trash</strong> (“Move to trash”). Nothing is erased yet:
              you can “Restore” it.
            </li>
            <li>
              In <strong>Trash</strong>, catalogues and products are listed
              separately. Tick one or more items, then “Restore” or “Delete
              permanently”. Permanent deletion erases the product and its photo:
              it cannot be undone.
            </li>
            <li>
              The sales history is kept after a permanent deletion: past sales
              keep the product name and are still counted in the analytics.
            </li>
          </ul>
          <p>The trash requires the “Manage trash” right.</p>
        </>
      ),
    },
    {
      id: "hors-ligne",
      title: "Working without a connection",
      content: (
        <>
          <p>
            {SITE.name} lets you keep selling when the network goes down, under
            these conditions:
          </p>
          <ul>
            <li>
              you must have opened the application with network in the{" "}
              <strong>last 72 hours</strong>, on the same device and with the
              same account;
            </li>
            <li>
              without network, only the catalogue and recording sales are
              available. Adding products, viewing analytics or managing the team
              needs a connection;
            </li>
            <li>
              the stock shown without network is a guide only: it does not
              include sales made in the meantime on other devices.
            </li>
          </ul>
          <h3>Synchronisation</h3>
          <ul>
            <li>
              Sales entered without network are marked “pending” and sent
              automatically when the connection comes back.
            </li>
            <li>
              The server checks each sale. If one is refused (not enough stock,
              right removed…), it stays in “Pending sales”: “Correct”, “Try
              again” or, after confirmation, “Abandon”. A refused sale does not
              block the others.
            </li>
            <li>
              A device keeps at most 200 pending sales, each for 14 days at
              most. If sending is delayed, open “Pending sales” to see the
              reason and correct them or send them again.
            </li>
            <li>Logging out does not delete pending sales.</li>
          </ul>
          <h3>Products tracked by batches</h3>
          <ul>
            <li>
              Without network, you can sell a product tracked by batches if its
              batches were loaded with network on this device. Quantities per
              batch are not checked offline: nothing is reserved.
            </li>
            <li>
              If a chosen batch no longer has enough units or is no longer
              available when syncing, the sale is refused: choose “Correct” to
              change the batches.
            </li>
            <li>
              If the sale was entered before the batch expired but received
              after, it must be regularised. With the “Adjust stock” right,
              choose “Regularise”. Otherwise, choose “Request a regularisation”:
              the request appears in the “Regularisations to review” card on the{" "}
              <strong>Sales</strong> page, where a manager (“Adjust stock” and
              “See all sales” rights) chooses “Approve” or “Reject”. Nothing is
              recorded before approval.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "abonnement",
      title: "Subscription and renewal",
      content: (
        <ul>
          <li>
            The {TRIAL_DAYS}-day trial starts when the shop is created. Its
            status and end date are shown in{" "}
            <strong>Organisation, then Subscription</strong>.
          </li>
          <li>
            Lengths and prices are set out in the{" "}
            <Link href="/en/conditions-abonnement">Subscription Terms</Link>.
          </li>
          <li>
            To renew, the owner chooses a length in Organisation, then
            Subscription, and pays once by Mobile Money (MTN or Orange) on
            SasPay&apos;s secure page. Payment fees are covered by Stock Master.
            Back in Stock Master, “Check payment” confirms the subscription. For
            any question, message us on WhatsApp or use{" "}
            <a href="#aide">support</a>.
          </li>
          <li>
            When the subscription ends without renewal, access to the shop is
            blocked for all its members. The data is not erased, and pending
            sales stay on the device.
          </li>
        </ul>
      ),
    },
    {
      id: "notifications",
      title: "Notifications, installation and push",
      content: (
        <>
          <h3>Notification centre</h3>
          <p>
            The bell at the top of the application opens your notifications:
            product out of stock or nearly out of stock, new sales, expiry
            approaching, expired products, regularisations to review, end of
            trial or subscription, payment confirmed, monthly summary. You only
            receive those that match your rights.
          </p>
          <h3>Install the application</h3>
          <ul>
            <li>
              On browsers that allow it (for example Chrome), the “Install”
              button adds {SITE.name} to the home screen.
            </li>
            <li>
              On iPhone and iPad, in Safari: tap Share, then “Add to Home
              Screen”.
            </li>
          </ul>
          <h3>Turn notifications on the device on or off</h3>
          <ol>
            <li>
              Open <strong>Organisation, then Notifications</strong>.
            </li>
            <li>
              Choose “Turn on notifications”, then accept the browser&apos;s
              request.
            </li>
            <li>Tick the categories you are interested in.</li>
            <li>
              To stop, choose “Turn off notifications”. You can also block them
              in the browser settings.
            </li>
          </ol>
          <p>
            The setting applies to this device only. On iPhone and iPad,
            notifications are only offered to the application added to the home
            screen.
          </p>
          <h3>Logging out and back in</h3>
          <ul>
            <li>
              When you log out, the device stops receiving your notifications;
              your category choices are kept.
            </li>
            <li>
              When you log back in on the same device, they resume without a new
              browser request. If the device was used for another account,{" "}
              {SITE.name} offers “Link this device to notifications”: one click
              is enough.
            </li>
            <li>
              “Later” postpones the invitation for 7 days on this device. After
              “Turn off notifications”, it is no longer offered automatically.
            </li>
          </ul>
          <p>
            A device&apos;s “subscription” to notifications only means it is
            registered to receive them.{" "}
            <strong>It does not involve any payment</strong> and has nothing to
            do with the shop&apos;s subscription.
          </p>
          <p>
            Messages stay general on the lock screen. If a notification does not
            arrive on a device, the bell remains the reference.
          </p>
        </>
      ),
    },
    {
      id: "aide",
      title: "Need help?",
      content: (
        <>
          <h3>On WhatsApp (recommended)</h3>
          <p>
            Message us on WhatsApp at any time, on{" "}
            <a
              href={WHATSAPP.url}
              target="_blank"
              rel="noopener noreferrer"
              translate="no"
            >
              {WHATSAPP.display}
            </a>
            . We reply as soon as we can.
          </p>
          <ul>
            <li>
              In the application, the WhatsApp button at the bottom of the
              screen or <strong>Organisation, then Support</strong> lets you
              prepare a subject and a message, then choose “Continue on
              WhatsApp”. On the website, the same button is at the bottom right
              of the pages.
            </li>
            <li>
              WhatsApp opens with your text: send it to start the conversation.{" "}
              {SITE.name} sends nothing for you and adds no information about
              your account.
            </li>
            <li>
              The conversation continues in WhatsApp:{" "}
              <strong>
                it is neither saved nor synchronised in {SITE.name}
              </strong>
              , and it does not create a support request.
            </li>
            <li>
              Never share your password or a code received by text message or
              email.
            </li>
          </ul>
          <h3>By email, from the application</h3>
          <ol>
            <li>
              Open <strong>Organisation, then Support</strong>, “By email”
              section.
            </li>
            <li>
              Choose a category (Using the app, Subscription, Technical problem,
              Other), then write a subject and your message.
            </li>
            <li>
              Check the “Information sent to customer support” block: your name,
              email, shop, role and identifiers are attached automatically to
              find your account. No sale and no buyer contact is attached.
            </li>
            <li>
              Choose “Send to customer support”. A request reference is shown:
              write it down. The reply arrives at your email address.
            </li>
          </ol>
          <p>
            Sending needs an Internet connection. If it fails, your text stays
            on the screen: try again without retyping it. The owner and the
            administrators have access to Support; a seller only if they have
            been given the “Contact customer support” right.
          </p>
          <h3>No access to your shop</h3>
          <p>
            Message us on WhatsApp, or write to <MailLink to="support" />,
            stating the name of your shop, the screen concerned and what you
            tried. The other contacts are on the{" "}
            <Link href="/en/contact">Contact</Link> page.
          </p>
        </>
      ),
    },
  ],
};

export default content;
