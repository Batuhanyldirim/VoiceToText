"""Başlangıç not şablonları (A bölümüne verilen örnek formatlar), Türkçe.

Hekimlerin tanıdığı iki hazır seçenek — SOAP ve Öykü & Muayene (Ö&M) — artı
kullanıcının kendi örnek formatını yapıştırdığı serbest metin yolu. Şablon metni,
kullanıcı istemine birebir eklenir (bkz. prompt.build_user_prompt); A bölümünün
*formatını* yönlendirir, sistem istemi ise çıkarım ve güvenliği yönetir.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Template:
    key: str
    label: str
    description: str
    text: str


SOAP = Template(
    key="soap",
    label="SOAP notu",
    description="Subjektif, Objektif, Değerlendirme, Plan — yaygın poliklinik formatı.",
    text="""\
# SOAP Notu

## Subjektif
- Ana yakınma:
- Şimdiki hastalık öyküsü (ŞHÖ):
- Özgeçmiş / geçirilmiş cerrahi öykü:
- İlaçlar (ad, doz, yol, sıklık, uyum):
- Alerjiler:
- Aile öyküsü:
- Sosyal öykü:
- Sistemlerin gözden geçirilmesi (SGG):

## Objektif
- Vital bulgular (yalnızca belirtildiyse):
- Fizik muayene bulguları (yalnızca belirtildiyse):
- Laboratuvar / görüntüleme / diğer sonuçlar (yalnızca belirtildiyse):

## Değerlendirme
- Hekimin değerlendirmesi / çalışılan sorunlar (yalnızca belirtildiği gibi):

## Plan
- Yönetim, başlanan/değiştirilen/kesilen ilaçlar:
- İstemler, sevkler, takip, dönüş uyarıları:
""",
)

HP = Template(
    key="hp",
    label="Öykü ve Muayene (Ö&M)",
    description="Tam öykü ve muayene — kapsamlı yatış/konsültasyon formatı.",
    text="""\
# Öykü ve Muayene

## Kimlik / Demografi
- Hasta, yaş, cinsiyet (yalnızca belirtildiği gibi):

## Ana Yakınma

## Şimdiki Hastalık Öyküsü (ŞHÖ)

## Özgeçmiş (Tıbbi Öykü)

## Geçirilmiş Cerrahi Öykü

## İlaçlar
- (ad, doz, yol, sıklık, uyum, değişiklikler)

## Alerjiler

## Aile Öyküsü

## Sosyal Öykü

## Sistemlerin Gözden Geçirilmesi (SGG)

## Fizik Muayene
- (yalnızca fiilen bahsedilen bulgular)

## Sonuçlar
- Laboratuvar / görüntüleme / genetik / patoloji (yalnızca belirtildiği gibi)

## Değerlendirme

## Plan
- İstemler, sevkler, takip, dönüş uyarıları
""",
)

TEMPLATES = {t.key: t for t in (SOAP, HP)}

# API/UI'nin tam metni hemen içe aktarmadan listeleyebileceği herkese açık meta.
TEMPLATE_CHOICES = [
    {"key": t.key, "label": t.label, "description": t.description}
    for t in (SOAP, HP)
]


def resolve_template_text(template: str, template_text: str | None) -> str:
    """Bir şablon anahtarı için örnek-format metnini ya da kullanıcının yapıştırdığı
    serbest metni döndür. Bilinmeyen anahtar veya boş serbest metinde ValueError."""
    key = (template or "").strip().lower()
    if key in ("free", "freetext", "free-text", "custom", "serbest"):
        if not template_text or not template_text.strip():
            raise ValueError(
                "template='free' için template_text gerekir (bir örnek not formatı yapıştırın)."
            )
        return template_text
    tpl = TEMPLATES.get(key)
    if tpl is None:
        valid = ", ".join(sorted(TEMPLATES)) + ", free"
        raise ValueError(f"bilinmeyen şablon '{template}'. Geçerli: {valid}")
    return tpl.text
