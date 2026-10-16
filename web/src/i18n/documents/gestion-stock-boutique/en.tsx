import Link from "next/link";
import { ArticleCta } from "@/components/public/article-cta";
import { DemoSalesCapture } from "@/components/public/demo-sales-capture";
import { formatFcfa } from "@/i18n/format";
import { SITE } from "@/lib/legal/site-identity";
import { TRIAL_DAYS } from "@/lib/subscription-offers";
import type { ArticleContent } from "@/i18n/documents/types";
import { REORDER_EXAMPLE, STOCK_EXAMPLE } from "./example";

// Guide pratique « gérer le stock d'une boutique », en anglais : même
// structure, mêmes ancres et mêmes capacités vérifiées que `fr.tsx`. Les
// noms de boutons sont ceux de l'interface anglaise
// (`i18n/resources/en/*`).
const registrationEnabled =
  process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";

const ex = STOCK_EXAMPLE;
const fcfa = (amount: number) => formatFcfa(amount, "en");

const content: ArticleContent = {
  metaTitle: "Managing stock in a shop in Cameroon",
  metaDescription:
    "A simple method for small shops: product records and variants, opening stock, deliveries, sales and losses, restocking, team roles and stock counts.",
  title: "How to manage stock in a shop in Cameroon",
  intro: (
    <>
      <p>
        A product nobody can find, your best seller out of stock, an unexplained
        gap at the end of the month: in a small shop, especially a cosmetics
        shop, stock quickly gets out of hand. Here is a six-step method you can
        apply with a notebook, a spreadsheet or an app.
      </p>
      <p className="mt-3">
        Steps 1 to 6 are general good practice. Part 8 then shows what{" "}
        {SITE.name} helps you apply, and what you still need to record
        separately.
      </p>
    </>
  ),
  sections: [
    {
      id: "fiches-produits",
      title: "Create one record per product and separate variants",
      content: (
        <>
          <p>
            A record matches one item you can count on its own. Each size,
            scent, shade or format gets its own record: “Shea body lotion 250
            ml” and “Shea body lotion 500 ml” are two products, because they
            have neither the same price nor the same sales pace.
          </p>
          <ul>
            <li>
              Use a precise, stable name: brand, product, variant, size. Avoid
              catch-all records such as “various creams”.
            </li>
            <li>
              Record the purchase price, the sale price and the quantity in
              stock for each product. A photo helps sellers pick the right item.
            </li>
            <li>
              Group records by family (body care, hair, make-up, perfume) to
              find them quickly.
            </li>
            <li>
              For products that expire, write down the dates and sell the oldest
              first.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "stock-de-depart",
      title: "Count your opening stock",
      content: (
        <>
          <p>
            Every calculation will start from this count: take the time to do it
            properly, once.
          </p>
          <ul>
            <li>Pick a time with no sales: before opening or after closing.</li>
            <li>
              Count shelf by shelf, in pairs if possible: one person counts, the
              other writes.
            </li>
            <li>
              Set aside damaged, opened or expired items: they are not part of
              the stock you can sell.
            </li>
            <li>Write down the date of the count.</li>
          </ul>
        </>
      ),
    },
    {
      id: "mouvements",
      title: "Record every delivery, sale, return or loss",
      content: (
        <>
          <p>
            Stock only changes through movements. If each one is recorded when
            it happens, the expected stock is easy to work out:
          </p>
          <p>
            <strong>
              Expected stock = opening stock + deliveries − outgoings (sales,
              losses, returns to the supplier)
            </strong>
          </p>
          <ul>
            <li>
              <strong>Deliveries</strong>: for each delivery, count the items
              and compare them with the delivery note or invoice before you pay.
            </li>
            <li>
              <strong>Sales</strong>: record them when they happen, not from
              memory in the evening.
            </li>
            <li>
              <strong>Returns</strong>: an item brought back by a customer and
              still sellable goes back into stock; an item sent back to the
              supplier leaves it.
            </li>
            <li>
              <strong>Losses</strong>: damaged, expired or broken product,
              opened tester, theft found. Write down the date, the quantity and
              the reason. An unrecorded loss becomes an unexplained gap at the
              next count.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "reapprovisionnement",
      title: "Choose which products to watch for restocking",
      content: (
        <>
          <p>
            Not every product needs the same attention. Identify your best
            sellers and the items that must never run out, then set a reorder
            point for each:
          </p>
          <p>
            <strong>
              Reorder point = average sales per day × (supplier lead time + a
              few days of margin)
            </strong>
          </p>
          <p>
            For example, a product that sells about {REORDER_EXAMPLE.dailySales}{" "}
            units a day, delivered in {REORDER_EXAMPLE.supplierDelayDays} days,
            with {REORDER_EXAMPLE.safetyDays} days of margin:{" "}
            {REORDER_EXAMPLE.dailySales} × ({REORDER_EXAMPLE.supplierDelayDays}{" "}
            + {REORDER_EXAMPLE.safetyDays}) = {REORDER_EXAMPLE.reorderPoint}. As
            soon as {REORDER_EXAMPLE.reorderPoint} are left, reorder.
          </p>
          <ul>
            <li>
              Review reorder points when sales change: holidays, back to school,
              a product that becomes popular.
            </li>
            <li>
              Also spot the products that no longer sell: they tie up your
              money. Do not reorder them out of habit.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "equipe",
      title: "Share responsibilities within the team",
      content: (
        <>
          <p>
            Knowing who does what is not about distrust: it lets you find and
            fix a mistake quickly.
          </p>
          <ul>
            <li>Only one or two people receive deliveries and record them.</li>
            <li>Each seller records their own sales, when they make them.</li>
            <li>
              Corrections, returns and losses are reported to one named person,
              who records them.
            </li>
            <li>The owner or manager organises counts and reviews gaps.</li>
            <li>
              When someone leaves the shop, remove their access to your tools.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "inventaire",
      title: "Regularly compare recorded stock with physical stock",
      content: (
        <>
          <ul>
            <li>
              Do a full count at least once a month and, every week, a quick
              count of expensive or fast-selling products.
            </li>
            <li>
              Count first, then compare with the recorded stock: do not start
              from the expected figure.
            </li>
            <li>
              If there is a gap, find the cause before correcting: an unrecorded
              sale, an incomplete delivery, two variants mixed up, a forgotten
              loss.
            </li>
            <li>
              Write down each gap and its cause. If the same products keep
              coming back, change the way you handle them.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "exemple",
      title: "Worked example: remaining stock and revenue",
      content: (
        <>
          <p>
            <strong>Fictional example, for teaching purposes</strong>: it does
            not describe the situation of any {SITE.name} customer. The product
            is a shea body lotion 250 ml, sold at {fcfa(ex.unitPriceXaf)} each.
          </p>
          <div className="overflow-x-auto">
            <table>
              <caption className="pb-2 text-left text-sm text-(--public-muted)">
                Movements of the shea body lotion 250 ml over the period
              </caption>
              <thead>
                <tr>
                  <th scope="col">Movement</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Stock after</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                <tr>
                  <th scope="row">Opening stock (count)</th>
                  <td>{ex.opening}</td>
                  <td>{ex.opening}</td>
                </tr>
                <tr>
                  <th scope="row">Delivery received</th>
                  <td>+{ex.received}</td>
                  <td>{ex.afterReceipt}</td>
                </tr>
                <tr>
                  <th scope="row">Sales</th>
                  <td>−{ex.sold}</td>
                  <td>{ex.afterSales}</td>
                </tr>
                <tr>
                  <th scope="row">Damaged bottle (loss)</th>
                  <td>−{ex.damaged}</td>
                  <td>{ex.remaining}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            <strong>
              Expected remaining stock: {ex.opening} + {ex.received} − {ex.sold}{" "}
              − {ex.damaged} = {ex.remaining} units.
            </strong>{" "}
            If you count {ex.remaining} on the shelf, everything is in order. If
            you count fewer, the gap needs explaining.
          </p>
          <p>
            The {ex.sold} sales amount to {ex.sold} × {fcfa(ex.unitPriceXaf)} ={" "}
            <strong>{fcfa(ex.revenueXaf)}</strong> in revenue. That is not
            profit: to get profit, you must at least subtract the purchase price
            of the {ex.sold} bottles sold, the value of the damaged bottle and
            the shop&apos;s costs (rent, transport, electricity…). Nor is it
            necessarily the cash collected, if some sales were made on credit.
          </p>
        </>
      ),
    },
    {
      id: "stock-master",
      title: "Apply the method with Stock Master",
      content: (
        <>
          <p>
            Steps 1 to 6 work with any tool. Here are the operations actually
            available today in {SITE.name}, a stock and sales management app
            used from your phone, to apply them. The screens are described in
            detail in the <Link href="/en/guide">user guide</Link>.
          </p>

          <h3>Product records and variants</h3>
          <ul>
            <li>
              Each product has a name, a photo (required), a purchase price, a
              sale price and an initial quantity. Products are organised into
              categories and sub-categories (“New section”).
            </li>
            <li>
              Create one product per variant (250 ml and 500 ml, for example),
              as in step 1.
            </li>
          </ul>

          <h3>Opening stock</h3>
          <p>
            The initial quantity entered when you create the product is your
            opening stock: enter the result of your count.
          </p>

          <h3>Deliveries and sales</h3>
          <ul>
            <li>
              <strong>Deliveries</strong>: “Edit” on the product, then
              “Additional stock to add” (“Adjust stock” right).
            </li>
            <li>
              <strong>Sales</strong>: “Record a sale” on the product. Each sale
              lowers the stock and keeps the seller, the date and the time.
              Sales can also be entered without a network, under{" "}
              <Link href="/en/guide#hors-ligne">certain conditions</Link>.
            </li>
            <li>
              <strong>Entry mistakes</strong>: depending on your rights, a sale
              recorded by mistake can be corrected or deleted; the units then go
              back into stock.
            </li>
            <li>
              The product&apos;s “Full history” lists its creation, sales, stock
              additions, price changes and edited or cancelled sales, with who
              did it and when (“See the audit history” right).
            </li>
          </ul>
          <DemoSalesCapture />

          <h3>Products to watch</h3>
          <ul>
            <li>
              Each product shows “In stock”, “Low stock” or “Out of stock”. “Low
              stock” appears when 20% or less of the total quantity entered
              (initial quantity plus additions) is left. This threshold is the
              same for every product: keep your own reorder points (step 4) for
              important products.
            </li>
            <li>
              Members with the “See stock details” right are notified when a
              product is almost or completely out of stock.
            </li>
            <li>
              The <strong>Analytics</strong> page (“View analytics” right)
              gathers under “To watch” the stock-outs, the products “Running out
              soon” (about 7 days of stock or less at the pace of recorded
              sales, when there are enough sales to estimate) and those with no
              recent sales.
            </li>
          </ul>

          <h3>Team and rights</h3>
          <ul>
            <li>
              Three roles: Owner, Administrator and Seller. By default, a seller
              records sales and sees their own; they can also correct or delete
              their own sales, and every correction stays visible in the
              product&apos;s history.
            </li>
            <li>
              You add other rights one by one, for example “Adjust stock” only
              for the person who receives deliveries.
            </li>
            <li>
              The owner is notified when another member edits a product (adding
              stock, for example), corrects or cancels a sale.
            </li>
            <li>
              A member can be suspended or revoked. See{" "}
              <Link href="/en/guide#membres">roles and rights</Link>.
            </li>
          </ul>

          <h3>Compare with physical stock</h3>
          <ul>
            <li>
              Each product&apos;s “Remaining stock” is the recorded stock to
              compare with your count. First sync any sales entered without a
              network.
            </li>
            <li>
              If the gap comes from an entry mistake, correct the sale concerned
              or add the forgotten delivery.
            </li>
            <li>
              The owner and administrators can download a month&apos;s history
              (Excel or PDF): sales, corrections and cancellations, to check a
              period.
            </li>
          </ul>

          <h3>Record separately</h3>
          <p>
            These movements are not recorded in {SITE.name}: keep them in a
            notebook or a spreadsheet, with the date, the quantity and the
            reason.
          </p>
          <ul>
            <li>
              Customer returns and returns to the supplier. Correcting or
              deleting a sale is for fixing an entry mistake: it is not a way to
              track returns.
            </li>
            <li>
              Losses: damaged or expired products, opened testers, theft found.
            </li>
            <li>Expiry dates and the results of your counts.</li>
          </ul>
          <p>
            The stock shown only goes down through a sale: in the example above,
            the app shows {ex.afterSales} units while the shelf holds{" "}
            {ex.remaining}. Take these notes into account at every count.
          </p>
        </>
      ),
    },
  ],
  closing: registrationEnabled ? (
    <ArticleCta
      id="essayer"
      title="Apply this method with Stock Master"
      text={
        <p>
          Create your account, then add your products and invite your sellers
          from your phone. A new account creates its shop and gets a{" "}
          {TRIAL_DAYS}-day free trial, which starts when the shop is created.
        </p>
      }
      primary={{ href: "/auth/register", label: "Create an account" }}
      secondary={{ href: "/en", label: "Discover Stock Master" }}
      note={
        <p>
          <Link href="/en#tarifs">See pricing</Link> · Already registered?{" "}
          <Link href="/auth/login">Log in</Link>
        </p>
      }
    />
  ) : (
    <ArticleCta
      id="essayer"
      title="Discover Stock Master"
      text={
        <p>
          Online sign-up is temporarily closed. Find out what {SITE.name} does
          and how much it costs; if you already have an account, log in.
        </p>
      }
      primary={{ href: "/en", label: "Discover Stock Master" }}
      secondary={{ href: "/auth/login", label: "Log in" }}
      note={
        <p>
          <Link href="/en#tarifs">See pricing</Link>
        </p>
      }
    />
  ),
};

export default content;
