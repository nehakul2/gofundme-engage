import type { Metadata } from 'next';
import NotificationList from '@/components/NotificationList';

export const metadata: Metadata = { title: 'Notifications | Engage' };

export default function NotificationsPage() {
  return (
    <>
      <h1>Notifications</h1>
      <NotificationList />
    </>
  );
}
