import { getDashboardData } from "@/lib/get-dashboard-data";
import { DashboardApp } from "@/components/dashboard-app";

export const revalidate = 1200;

export default async function HomePage() {
  const data = await getDashboardData();
  return <DashboardApp data={data} />;
}
