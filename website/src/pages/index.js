import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <p className={styles.heroDescription}>
          A free, open-source alternative to iMazing. Extract data from your
          iPhone backups privately and locally — no cloud, no subscriptions,
          no tracking. Your data stays on your machine.
        </p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to="https://github.com/charleswest775/openextract/releases/latest">
            Download Latest
          </Link>
          <Link
            className="button button--outline button--lg"
            to="https://github.com/charleswest775/openextract">
            Star on GitHub
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function Home() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description="OpenExtract — Free, open-source iOS backup extractor. A privacy-first, local-only alternative to iMazing.">
      <HomepageHeader />
      <main>
        <section className={styles.features}>
          <div className="container">
            <div className="row">
              <div className={clsx('col col--4', styles.featureCard)}>
                <h3>Privacy First</h3>
                <p>
                  Everything runs locally on your machine. No data leaves your
                  computer. No accounts, no telemetry, no cloud uploads.
                </p>
              </div>
              <div className={clsx('col col--4', styles.featureCard)}>
                <h3>Completely Free</h3>
                <p>
                  MIT licensed and open source forever. No paywalls, no
                  trial limitations, no license keys required.
                </p>
              </div>
              <div className={clsx('col col--4', styles.featureCard)}>
                <h3>Full Backup Access</h3>
                <p>
                  Extract Messages, Contacts, Photos, Notes, Health data and
                  more from standard iPhone backups.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
