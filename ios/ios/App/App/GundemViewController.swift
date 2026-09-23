import UIKit
import WebKit
import Capacitor

/// Gündəm üçün əsas ekran: Capacitor körpüsü + iOS rahatlıqları
/// (aşağı çəkib yeniləmək → poçt, təqvim və sənədləri yeniləyir).
class GundemViewController: CAPBridgeViewController {
    private let refresher = UIRefreshControl()

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let webView = webView else { return }
        webView.scrollView.bounces = true
        refresher.tintColor = UIColor(red: 0.24, green: 0.75, blue: 0.71, alpha: 1)
        refresher.addTarget(self, action: #selector(refreshData), for: .valueChanged)
        webView.scrollView.refreshControl = refresher
        view.backgroundColor = UIColor(red: 0.04, green: 0.14, blue: 0.15, alpha: 1)
    }

    /// Səhifəni yenidən yükləmək əvəzinə tətbiqin öz "Yenilə" düyməsini basır (daha sürətli, vəziyyət itmir).
    @objc private func refreshData() {
        webView?.evaluateJavaScript("(document.getElementById('btn-refresh')||{click(){location.reload()}}).click()", completionHandler: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.refresher.endRefreshing()
        }
    }
}
