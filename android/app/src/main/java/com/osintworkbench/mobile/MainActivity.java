package com.osintworkbench.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;
import android.database.Cursor;

import com.google.i18n.phonenumbers.NumberParseException;
import com.google.i18n.phonenumbers.PhoneNumberUtil;
import com.google.i18n.phonenumbers.Phonenumber;

import java.text.DateFormat;
import java.util.Date;

public final class MainActivity extends Activity {
    private static final int BG = Color.rgb(17, 12, 12);
    private static final int PANEL = Color.rgb(31, 24, 24);
    private static final int PANEL_2 = Color.rgb(42, 32, 32);
    private static final int RED = Color.rgb(127, 31, 41);
    private static final int GOLD = Color.rgb(237, 157, 68);
    private static final int TEXT = Color.rgb(239, 231, 222);
    private static final int MUTED = Color.rgb(171, 158, 151);

    private final PhoneNumberUtil phoneUtil = PhoneNumberUtil.getInstance();
    private CaseStore store;
    private LinearLayout page;
    private EditText phoneInput;
    private EditText noteInput;
    private Spinner regionInput;
    private TextView resultView;
    private String currentE164;
    private String currentDetails;
    private String currentInternational;
    private String currentNational;
    private String currentRegion;
    private String currentValidity;
    private String currentType;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        store = new CaseStore(this);
        Diagnostics.install(this);
        showPhone();
    }

    private int dp(float value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private TextView text(String value, float size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        view.setLineSpacing(dp(3), 1f);
        return view;
    }

    private LinearLayout column() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        return box;
    }

    private LinearLayout row() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.HORIZONTAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        return box;
    }

    private void space(LinearLayout parent, int height) {
        View gap = new View(this);
        parent.addView(gap, new LinearLayout.LayoutParams(1, dp(height)));
    }

    private void pad(View view, int all) {
        view.setPadding(dp(all), dp(all), dp(all), dp(all));
    }

    private void addLabel(LinearLayout parent, String value) {
        parent.addView(text(value, 13, MUTED, true));
        space(parent, 7);
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(14);
        b.setTextColor(TEXT);
        b.setBackgroundTintList(android.content.res.ColorStateList.valueOf(primary ? RED : PANEL_2));
        b.setMinHeight(dp(48));
        return b;
    }

    private EditText edit(String hint) {
        EditText e = new EditText(this);
        e.setSingleLine(false);
        e.setTextColor(TEXT);
        e.setHintTextColor(MUTED);
        e.setHint(hint);
        e.setTextSize(16);
        e.setPadding(dp(14), dp(12), dp(14), dp(12));
        e.setBackgroundTintList(android.content.res.ColorStateList.valueOf(GOLD));
        return e;
    }

    private LinearLayout card() {
        LinearLayout c = column();
        c.setBackgroundColor(PANEL);
        pad(c, 16);
        return c;
    }

    private void shell(String subtitle) {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        page = column();
        page.setBackgroundColor(BG);
        page.setPadding(dp(18), dp(22), dp(18), dp(28));
        scroll.addView(page);
        setContentView(scroll);

        TextView brand = text("OSINT WORKBENCH", 12, GOLD, true);
        brand.setLetterSpacing(0.16f);
        page.addView(brand);
        space(page, 6);
        page.addView(text("Мобильный инструмент", 25, TEXT, true));
        space(page, 4);
        page.addView(text(subtitle, 13, MUTED, false));
        space(page, 18);

        LinearLayout tabs = row();
        Button phone = button("Телефон", false);
        Button cases = button("Дела", false);
        Button about = button("Инфо", false);
        LinearLayout.LayoutParams tabLp = new LinearLayout.LayoutParams(0, -2, 1);
        tabLp.setMargins(0, 0, dp(6), 0);
        tabs.addView(phone, tabLp);
        tabs.addView(cases, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout.LayoutParams last = new LinearLayout.LayoutParams(0, -2, 1);
        last.setMargins(dp(6), 0, 0, 0);
        tabs.addView(about, last);
        page.addView(tabs);
        space(page, 18);
        phone.setOnClickListener(v -> showPhone());
        cases.setOnClickListener(v -> showCases());
        about.setOnClickListener(v -> showAbout());
    }

    private void showPhone() {
        currentE164 = null;
        currentDetails = null;
        shell("Локальный анализ номера и подготовка поисковых ссылок");
        LinearLayout panel = card();
        page.addView(panel);
        panel.addView(text("АНАЛИЗ НОМЕРА", 12, GOLD, true));
        space(panel, 14);
        addLabel(panel, "Номер телефона");
        phoneInput = edit("+7 999 123-45-67 или +1 212 555 0123");
        phoneInput.setInputType(3);
        phoneInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                if (currentE164 != null) {
                    currentE164 = null;
                    currentDetails = null;
                    if (resultView != null) {
                        resultView.setText("Номер изменён. Повторите анализ перед сохранением или поиском.");
                        resultView.setTextColor(MUTED);
                    }
                }
            }
            @Override public void afterTextChanged(Editable s) { }
        });
        panel.addView(phoneInput, new LinearLayout.LayoutParams(-1, dp(54)));
        space(panel, 14);
        addLabel(panel, "Регион для национального формата");
        regionInput = new Spinner(this);
        String[] regions = {"RU", "US", "GB", "DE", "FR", "UA", "KZ", "BY", "CA", "AU"};
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, regions);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        regionInput.setAdapter(adapter);
        panel.addView(regionInput, new LinearLayout.LayoutParams(-1, dp(48)));
        space(panel, 16);
        Button analyze = button("Разобрать номер", true);
        panel.addView(analyze, new LinearLayout.LayoutParams(-1, -2));
        analyze.setOnClickListener(v -> analyzePhone());

        space(page, 14);
        LinearLayout resultCard = card();
        page.addView(resultCard);
        resultCard.addView(text("РЕЗУЛЬТАТ", 12, GOLD, true));
        space(resultCard, 8);
        resultView = text("Введите номер и запустите локальный анализ. Данные не отправляются из приложения.", 14, MUTED, false);
        resultView.setTextIsSelectable(true);
        resultCard.addView(resultView);
        space(page, 12);

        addLabel(page, "Заметка к делу (необязательно)");
        noteInput = edit("Например: номер предоставлен владельцем для проверки");
        noteInput.setMinHeight(dp(76));
        page.addView(noteInput, new LinearLayout.LayoutParams(-1, dp(90)));
        space(page, 12);

        Button save = button("Сохранить в локальное дело", true);
        page.addView(save, new LinearLayout.LayoutParams(-1, -2));
        save.setOnClickListener(v -> saveCurrentCase());
        space(page, 10);
        Button search = button("Открыть поисковые ссылки", false);
        page.addView(search, new LinearLayout.LayoutParams(-1, -2));
        search.setOnClickListener(v -> showSearchLinks());
        space(page, 12);
        page.addView(text("Важно: страна нумерации не означает местонахождение человека или текущего владельца номера. Поисковые ссылки лишь формируют запросы; результаты не проверяются автоматически.", 12, MUTED, false));
    }

    private void analyzePhone() {
        String raw = phoneInput.getText().toString().trim();
        if (raw.isEmpty()) { toast("Введите номер телефона"); return; }
        String region = String.valueOf(regionInput.getSelectedItem());
        try {
            Phonenumber.PhoneNumber number = phoneUtil.parse(raw, region);
            boolean possible = phoneUtil.isPossibleNumber(number);
            boolean valid = phoneUtil.isValidNumber(number);
            currentE164 = phoneUtil.format(number, PhoneNumberUtil.PhoneNumberFormat.E164);
            currentInternational = phoneUtil.format(number, PhoneNumberUtil.PhoneNumberFormat.INTERNATIONAL);
            currentNational = phoneUtil.format(number, PhoneNumberUtil.PhoneNumberFormat.NATIONAL);
            currentRegion = phoneUtil.getRegionCodeForNumber(number);
            currentType = typeName(phoneUtil.getNumberType(number));
            currentValidity = valid ? "Формат соответствует плану нумерации" :
                (possible ? "Номер возможен по длине, но не подтверждён как действующий диапазон" : "Номер не соответствует ожидаемой длине");
            String country = currentRegion == null ? "не определена" : currentRegion;
            currentDetails = "E.164: " + currentE164 +
                "\nМеждународный: " + currentInternational +
                "\nНациональный: " + currentNational +
                "\nРегион нумерации: " + country +
                "\nКод страны: +" + number.getCountryCode() +
                "\nТип линии: " + currentType +
                "\nПроверка формата: " + currentValidity +
                "\n\nЭто локальная проверка формата и плана нумерации. Она не устанавливает владельца, оператора или физическое местоположение.";
            resultView.setText(currentDetails);
            resultView.setTextColor(TEXT);
        } catch (NumberParseException ex) {
            currentE164 = null;
            currentDetails = null;
            resultView.setText("Не удалось разобрать номер: " + ex.getMessage() +
                "\n\nУкажите международный формат с + или выберите правильный регион.");
            resultView.setTextColor(GOLD);
        }
    }

    private String typeName(PhoneNumberUtil.PhoneNumberType type) {
        switch (type) {
            case MOBILE: return "мобильный";
            case FIXED_LINE: return "стационарный";
            case FIXED_LINE_OR_MOBILE: return "стационарный или мобильный";
            case VOIP: return "VoIP";
            case TOLL_FREE: return "бесплатный";
            case PREMIUM_RATE: return "платный";
            case SHARED_COST: return "разделённая стоимость";
            case PERSONAL_NUMBER: return "персональный";
            case PAGER: return "пейджер";
            case UAN: return "универсальный доступ";
            case VOICEMAIL: return "голосовая почта";
            default: return "не определён";
        }
    }

    private void saveCurrentCase() {
        if (currentE164 == null || currentDetails == null) {
            toast("Сначала выполните анализ номера"); return;
        }
        String note = noteInput.getText().toString().trim();
        store.add("Телефон " + currentE164, currentE164, note, currentDetails);
        toast("Сохранено только на этом устройстве");
        noteInput.setText("");
    }

    private void showSearchLinks() {
        if (currentE164 == null) { toast("Сначала выполните анализ номера"); return; }
        String q = "\"" + currentE164 + "\"";
        String[] labels = {"Точное совпадение", "Социальные сайты", "Общий поиск"};
        String[] queries = {
            q,
            q + " (site:facebook.com OR site:instagram.com OR site:linkedin.com)",
            q + " -site:facebook.com -site:instagram.com -site:linkedin.com"
        };
        LinearLayout list = column();
        list.addView(text("Ссылки только подготовлены локально. Нажатие откроет браузер и передаст запрос выбранной поисковой системе.", 13, MUTED, false));
        for (int i = 0; i < labels.length; i++) {
            final String query = queries[i];
            Button b = button(labels[i], i == 0);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
            lp.topMargin = dp(8);
            list.addView(b, lp);
            b.setOnClickListener(v -> openQuery(query));
        }
        new AlertDialog.Builder(this).setTitle("Поисковые ссылки").setView(list)
            .setNegativeButton("Закрыть", null).show();
    }

    private void openQuery(String query) {
        String url = "https://www.google.com/search?q=" + Uri.encode(query);
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
        catch (Exception e) { toast("Не найден браузер для открытия ссылки"); }
    }

    private void showCases() {
        shell("Локальные записи на этом устройстве");
        Button refresh = button("Обновить список", false);
        page.addView(refresh);
        refresh.setOnClickListener(v -> showCases());
        space(page, 12);
        Cursor cursor = store.all();
        int count = 0;
        try {
            while (cursor.moveToNext()) {
                count++;
                long id = cursor.getLong(0);
                String title = cursor.getString(1);
                String phone = cursor.getString(2);
                String note = cursor.getString(3);
                String details = cursor.getString(4);
                long created = cursor.getLong(5);
                LinearLayout c = card();
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
                lp.bottomMargin = dp(10);
                page.addView(c, lp);
                c.addView(text(title, 16, TEXT, true));
                space(c, 5);
                c.addView(text(DateFormat.getDateTimeInstance().format(new Date(created)), 12, MUTED, false));
                if (note != null && !note.isEmpty()) {
                    space(c, 7);
                    c.addView(text(note, 13, MUTED, false));
                }
                space(c, 10);
                LinearLayout actions = row();
                Button share = button("Поделиться", false);
                Button delete = button("Удалить", false);
                actions.addView(share, new LinearLayout.LayoutParams(0, -2, 1));
                LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, -2, 1);
                half.setMargins(dp(8), 0, 0, 0);
                actions.addView(delete, half);
                c.addView(actions);
                share.setOnClickListener(v -> shareCase(title, phone, note, details));
                delete.setOnClickListener(v -> new AlertDialog.Builder(this)
                    .setTitle("Удалить запись?")
                    .setMessage("Запись будет удалена из локальной базы приложения.")
                    .setNegativeButton("Отмена", null)
                    .setPositiveButton("Удалить", (d, w) -> {
                        store.delete(id); showCases();
                    }).show());
                c.setOnClickListener(v -> new AlertDialog.Builder(this)
                    .setTitle(title).setMessage(details)
                    .setPositiveButton("Закрыть", null).show());
            }
        } finally { cursor.close(); }
        if (count == 0) {
            LinearLayout empty = card();
            page.addView(empty);
            empty.addView(text("Пока нет сохранённых дел. Выполните анализ номера и сохраните запись.", 14, MUTED, false));
        }
    }

    private void shareCase(String title, String phone, String note, String details) {
        String body = title + "\n" + phone + "\n" + (note == null ? "" : note + "\n") + "\n" + details;
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_SUBJECT, title);
        send.putExtra(Intent.EXTRA_TEXT, body);
        startActivity(Intent.createChooser(send, "Поделиться записью"));
    }

    private void showAbout() {
        shell("Принципы работы и ограничения");
        LinearLayout c = card();
        page.addView(c);
        c.addView(text("ЛОКАЛЬНОСТЬ ПО УМОЛЧАНИЮ", 12, GOLD, true));
        space(c, 8);
        c.addView(text("Приложение использует сеть только для локального моста Termux на 127.0.0.1. Номер разбирается на телефоне; записи хранятся в локальной SQLite-базе приложения. Контакты, геолокация и адресная книга не запрашиваются.", 14, TEXT, false));
        space(c, 16);
        c.addView(text("ДИАГНОСТИКА И СВЯЗЬ С GITHUB", 12, GOLD, true));
        space(c, 8);
        c.addView(text("Ошибки приложения сохраняются в закрытой локальной очереди. При запущенном мосте Termux они передаются в GitHub Issues. Номер телефона, заметки и записи дел не отправляются.", 14, TEXT, false));
        space(c, 10);
        Button sendLogs = button("Отправить накопленные отчёты", true);
        c.addView(sendLogs, new LinearLayout.LayoutParams(-1, -2));
        sendLogs.setOnClickListener(v -> { Diagnostics.flush(); toast("Очередь диагностики передана на отправку"); });
        space(c, 8);
        Button issues = button("Получить открытые ошибки GitHub", false);
        c.addView(issues, new LinearLayout.LayoutParams(-1, -2));
        issues.setOnClickListener(v -> Diagnostics.fetchIssues(value -> new AlertDialog.Builder(this)
            .setTitle("Открытые ошибки").setMessage(value).setPositiveButton("Закрыть", null).show()));
        space(c, 16);
        c.addView(text("ПОИСКОВЫЕ ССЫЛКИ", 12, GOLD, true));
        space(c, 8);
        c.addView(text("Поисковые запросы создаются локально. Только после явного нажатия ссылка открывается во внешнем браузере. Браузер и поисковая система получают запрос; приложение не видит и не проверяет результаты.", 14, TEXT, false));
        space(c, 16);
        c.addView(text("ЧЕГО ПРИЛОЖЕНИЕ НЕ УСТАНАВЛИВАЕТ", 12, GOLD, true));
        space(c, 8);
        c.addView(text("Страна нумерации не является текущим местоположением человека. Тип линии не доказывает владельца или абонента. Номер может быть перенесён, переоформлен или использоваться через виртуальную телефонию. Приложение не выполняет скрытый поиск людей.", 14, TEXT, false));
        space(c, 16);
        c.addView(text("Для работы с чужими данными используйте только законное основание и разрешение владельца. Сохраняйте минимально необходимые сведения.", 13, MUTED, false));
        space(page, 12);
        page.addView(text("OSINT Workbench Mobile · 0.1.0 · локальный мобильный компаньон", 12, MUTED, false));
    }

    private void toast(String value) {
        Toast.makeText(this, value, Toast.LENGTH_SHORT).show();
    }
}
