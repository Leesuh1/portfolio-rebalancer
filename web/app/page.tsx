import { getDashboardData } from "@/lib/get-dashboard-data";
import { DashboardApp } from "@/components/dashboard-app";

export const revalidate = 21600;

export default async function HomePage() {
  const data = await getDashboardData();
  return <DashboardApp data={data} />;
}
