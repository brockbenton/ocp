import MemberTopNav from '@/components/shared/MemberTopNav';
import MobileTabBar from '@/components/shared/MobileTabBar';
import PageContainer from '@/components/shared/PageContainer';
import BootstrapBanner from '@/components/shared/BootstrapBanner';

export default function GovernanceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas">
      <MemberTopNav active="governance" />
      <PageContainer className="space-y-6 px-5 pb-28 pt-6 md:py-12">
        <BootstrapBanner />
        {children}
      </PageContainer>
      <MobileTabBar active="vote" />
    </div>
  );
}
