import './globals.css';

export const metadata = {
    title: 'greenbot',
    description: 'Status of the local clicker'
};

export default function RootLayout({ children }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
